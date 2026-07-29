import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Dockerode from "dockerode";
import { getLog } from "../logging/logger.js";
import { reconcileOnBoot } from "./boot-reconciler.js";
import { type DockerodeLike, createDockerDriver } from "./docker-driver.js";
import type { HealthIO } from "./health.js";
import { createNativeDriver } from "./native-driver.js";
import { createNativeIO } from "./native-io.js";
import { createSystemOrchestrator } from "./orchestrator.js";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";
import type { LaunchKind, ManagedService, OrchestratorStatus, ServiceDriver, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "factory"]);

export type { SecretAccessor } from "./template-loader.js";

export interface ServiceVersionRecord {
  gateway: string;
  hermes: string;
  stt_service: string;
  tts_service: string;
}

export interface SystemOrchestratorService {
  readonly registry: Map<ServiceName, ManagedService>;
  applyAll(): Promise<OrchestratorStatus>;
  applySubset(names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus>;
  getStatus(): OrchestratorStatus;
  reconcile(): Promise<OrchestratorStatus>;
  getRequiredServicesStatus(
    gatewayVersion: string,
    hermesVersionPath: string,
    sttHealthUrl: string,
    ttsHealthUrl: string,
  ): Promise<ServiceVersionRecord>;
}

export interface FactoryDeps {
  managedServicesConfig: Record<string, unknown>;
  templateDir: string;
  secrets: SecretAccessor;
  healthIO: HealthIO;
  pollIntervalMs: number;
  applyTimeoutMs: number;
  /** Host-side env values (HOST_HOME, TZ, HOST_DOCKER_GID, HOST_CONFIG_DIR,
   *  MASS_LOCAL_IP) substituted into templates after secrets are tried. */
  hostEnv?: Record<string, string>;
  /** User-owned, mutable dir where the native backend keeps one pid file per
   *  service. Never under the root-owned code tree. */
  nativeRunDir: string;
}

const EMPTY_STATUS: OrchestratorStatus = {
  state: "idle",
  services: [],
  startedAt: null,
  finishedAt: null,
};

export async function createSystemOrchestratorService(deps: FactoryDeps): Promise<SystemOrchestratorService> {
  const readTemplate = (filename: string): Promise<string> => readFile(join(deps.templateDir, filename), "utf8");

  // Dockerode connects to /var/run/docker.sock by default.
  const docker = new Dockerode() as unknown as DockerodeLike;
  const nativeDriver = createNativeDriver(createNativeIO({ runDir: deps.nativeRunDir }));
  // One backend per launch kind; everything above this line stays agnostic.
  const drivers: Record<LaunchKind, ServiceDriver> = {
    docker: createDockerDriver({ docker }),
    native: nativeDriver,
  };

  // Mutable cell — registry is rebuilt before each apply so newly-written
  // secrets and config edits flow through without a gateway restart.
  let currentRegistry: Map<ServiceName, ManagedService> = new Map();
  let lastStatus: OrchestratorStatus = { ...EMPTY_STATUS };

  async function rebuildRegistry(): Promise<Map<ServiceName, ManagedService> | null> {
    const reg = await buildServiceRegistry({
      config: deps.managedServicesConfig,
      readTemplate,
      secrets: deps.secrets,
      ...(deps.hostEnv ? { hostEnv: deps.hostEnv } : {}),
    });
    if (!reg.ok) {
      log.warn("factory.registry-rebuild-failed", { error: reg.error });
      return null;
    }
    currentRegistry = reg.value;
    return reg.value;
  }

  async function withFreshOrchestrator<T>(
    fn: (orch: ReturnType<typeof createSystemOrchestrator>) => Promise<T>,
  ): Promise<T> {
    const reg = await rebuildRegistry();
    if (!reg) {
      // Registry build failed — required service has unresolvable bindings
      // or template-policy violation. Return a synthetic failed status so
      // the wizard / apply bar can render the failure.
      const failed: OrchestratorStatus = {
        state: "failed",
        services: [],
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      lastStatus = failed;
      return failed as T;
    }
    const orch = createSystemOrchestrator({
      registry: reg,
      drivers,
      healthIO: deps.healthIO,
      pollIntervalMs: deps.pollIntervalMs,
      applyTimeoutMs: deps.applyTimeoutMs,
    });
    const result = await fn(orch);
    lastStatus = orch.getStatus();
    return result;
  }

  return {
    get registry() {
      return currentRegistry;
    },
    applyAll: async () => withFreshOrchestrator(async (o) => o.applyAll()),
    applySubset: async (names) => withFreshOrchestrator(async (o) => o.applySubset(names)),
    getStatus: () => lastStatus,
    reconcile: async () => {
      // A SIGKILLed gateway cannot run a shutdown hook, so native children from
      // the previous process may still hold their ports. Reap before anything
      // tries to bind them.
      await nativeDriver.reapOrphans();
      return withFreshOrchestrator(async (o) =>
        reconcileOnBoot({
          drivers,
          registry: currentRegistry,
          orchestrator: { applyAll: () => o.applyAll() },
        }),
      );
    },
    getRequiredServicesStatus: (gatewayVersion, hermesVersionPath, sttHealthUrl, ttsHealthUrl) =>
      resolveVersions(() => lastStatus, gatewayVersion, hermesVersionPath, sttHealthUrl, ttsHealthUrl),
  };
}

async function readHermesVersion(hermesVersionPath: string): Promise<string> {
  try {
    const raw = await readFile(hermesVersionPath, "utf8");
    const version = raw.trim();
    log.debug("versions.hermes-read", { version, path: hermesVersionPath });
    return version;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("versions.hermes-read-failed", { reason, path: hermesVersionPath });
    return "unknown";
  }
}

const SERVICE_HEALTH_TIMEOUT_MS = 3000;

/** Fetch a companion service's version from its JSON `/health` endpoint. The
 *  orchestrator's service-status table never populates `version` (probes are
 *  tcp/http liveness checks, not version handshakes), so we hit the health
 *  endpoint directly. `label` tags the log lines (e.g. "stt", "tts"). Returns
 *  "unknown" on any error — the caller renders a dash. */
async function resolveHealthVersion(healthUrl: string, label: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SERVICE_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(healthUrl, { signal: ctl.signal });
    if (!res.ok) {
      log.warn(`versions.${label}-health-non-ok`, { url: healthUrl, status: res.status });
      return "unknown";
    }
    const body = (await res.json()) as { version?: string };
    const version = body.version ?? "unknown";
    log.debug(`versions.${label}-fetched`, { version, url: healthUrl });
    return version;
  } catch (err: unknown) {
    log.warn(`versions.${label}-fetch-failed`, {
      url: healthUrl,
      reason: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVersions(
  _getStatus: () => OrchestratorStatus,
  gatewayVersion: string,
  hermesVersionPath: string,
  sttHealthUrl: string,
  ttsHealthUrl: string,
): Promise<ServiceVersionRecord> {
  const [hermes, stt_service, tts_service] = await Promise.all([
    readHermesVersion(hermesVersionPath),
    resolveHealthVersion(sttHealthUrl, "stt"),
    resolveHealthVersion(ttsHealthUrl, "tts"),
  ]);
  log.debug("versions.resolved", { gateway: gatewayVersion, hermes, stt_service, tts_service });
  return { gateway: gatewayVersion, hermes, stt_service, tts_service };
}
