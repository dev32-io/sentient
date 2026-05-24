import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Dockerode from "dockerode";
import { getLog } from "../logging/logger.js";
import { reconcileOnBoot } from "./boot-reconciler.js";
import { type DockerodeLike, createDockerDriver } from "./docker-driver.js";
import type { HealthIO } from "./health.js";
import { createSystemOrchestrator } from "./orchestrator.js";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";
import type { ManagedService, OrchestratorStatus, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "factory"]);

export type { SecretAccessor } from "./template-loader.js";

export interface ServiceVersionRecord {
  gateway: string;
  hermes: string;
  stt_service: string;
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
  const driver = createDockerDriver({ docker });

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
      driver,
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
    reconcile: async () =>
      withFreshOrchestrator(async (o) =>
        reconcileOnBoot({
          driver,
          registry: currentRegistry,
          orchestrator: { applyAll: () => o.applyAll() },
        }),
      ),
    getRequiredServicesStatus: (gatewayVersion, hermesVersionPath, sttHealthUrl) =>
      resolveVersions(() => lastStatus, gatewayVersion, hermesVersionPath, sttHealthUrl),
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

const STT_HEALTH_TIMEOUT_MS = 3000;

/** Fetch STT version from its /health endpoint. The orchestrator's
 *  service-status table never populates `version` (probes are tcp/http liveness
 *  checks, not version handshakes), so we hit the JSON health endpoint
 *  directly. Returns "unknown" on any error — the caller renders a dash. */
async function resolveSttVersion(sttHealthUrl: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STT_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(sttHealthUrl, { signal: ctl.signal });
    if (!res.ok) {
      log.warn("versions.stt-health-non-ok", { url: sttHealthUrl, status: res.status });
      return "unknown";
    }
    const body = (await res.json()) as { version?: string };
    const version = body.version ?? "unknown";
    log.debug("versions.stt-fetched", { version, url: sttHealthUrl });
    return version;
  } catch (err: unknown) {
    log.warn("versions.stt-fetch-failed", {
      url: sttHealthUrl,
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
): Promise<ServiceVersionRecord> {
  const [hermes, stt_service] = await Promise.all([
    readHermesVersion(hermesVersionPath),
    resolveSttVersion(sttHealthUrl),
  ]);
  log.debug("versions.resolved", { gateway: gatewayVersion, hermes, stt_service });
  return { gateway: gatewayVersion, hermes, stt_service };
}
