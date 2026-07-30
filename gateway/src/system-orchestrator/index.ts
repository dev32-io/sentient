import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Dockerode from "dockerode";
import { getLog } from "../logging/logger.js";
import { reconcileOnBoot } from "./boot-reconciler.js";
import { type DockerodeLike, createDockerDriver } from "./docker-driver.js";
import { createHealthWatch } from "./health-watch.js";
import { type HealthIO, probeOnce } from "./health.js";
import { createNativeDriver } from "./native-driver.js";
import { createNativeIO } from "./native-io.js";
import { createSystemOrchestrator } from "./orchestrator.js";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";
import {
  type LaunchKind,
  MANAGED_NETWORK_TOPOLOGY,
  type ManagedService,
  type OrchestratorStatus,
  type ServiceDriver,
  type ServiceName,
} from "./types.js";

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
  /** Stops the post-boot health watchdog. Called on gateway shutdown so a
   *  pending tick cannot re-apply into a torn-down driver. Idempotent. */
  stopHealthWatch(): void;
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
  /** Post-boot health watchdog policy, from
   *  `config.yaml#system_orchestrator`. See health-watch.ts for why apply()
   *  alone cannot deliver "restart on crash". */
  healthWatch: {
    intervalMs: number;
    maxAttempts: number;
    backoffFactor: number;
  };
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
    docker: createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY }),
    native: nativeDriver,
  };

  // Mutable cell — registry is rebuilt before each apply so newly-written
  // secrets and config edits flow through without a gateway restart.
  let currentRegistry: Map<ServiceName, ManagedService> = new Map();
  let lastStatus: OrchestratorStatus = { ...EMPTY_STATUS };

  // Applies are SERIALIZED. Each one rebuilds the shared `currentRegistry`
  // cell, so two overlapping applies would interleave writes to it and could
  // recreate the same container twice. The watchdog below makes overlap a
  // routine possibility rather than an operator-only edge case, so the
  // serialization is load-bearing, not defensive.
  let applyChain: Promise<unknown> = Promise.resolve();
  let applyDepth = 0;

  function serializeApply<T>(fn: () => Promise<T>): Promise<T> {
    applyDepth += 1;
    // `then(fn, fn)` so a REJECTED predecessor still lets the next apply run —
    // one failed apply must not wedge the chain for the process lifetime.
    const run = applyChain.then(fn, fn);
    applyChain = run.catch(() => undefined);
    return run.finally(() => {
      applyDepth -= 1;
    });
  }

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

  /** `targets` names the services this apply actually touched, or null for an
   *  applyAll. A subset apply reports every NON-target as "pending" (runApply
   *  seeds all registry entries that way and only walks its targets), so
   *  replacing `lastStatus` wholesale would blank the status page for every
   *  service the apply never looked at. Keep the previous entry for those. */
  function mergeStatus(
    prev: OrchestratorStatus,
    next: OrchestratorStatus,
    targets: ReadonlySet<ServiceName> | null,
  ): OrchestratorStatus {
    if (targets === null) return next;
    const prevByName = new Map(prev.services.map((s) => [s.name, s]));
    return {
      ...next,
      services: next.services.map((s) => (targets.has(s.name) ? s : (prevByName.get(s.name) ?? s))),
    };
  }

  async function withFreshOrchestrator<T>(
    fn: (orch: ReturnType<typeof createSystemOrchestrator>) => Promise<T>,
    targets: ReadonlySet<ServiceName> | null = null,
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
    lastStatus = mergeStatus(lastStatus, orch.getStatus(), targets);
    return result;
  }

  const applySubsetSerialized = (names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus> =>
    serializeApply(() => withFreshOrchestrator(async (o) => o.applySubset(names), names));

  // ── Post-boot health watchdog ─────────────────────────────────────────────
  // apply() runs at boot, from the admin endpoint and from the wizard — never
  // when a service dies later. This is the other half of "restart on crash".
  const healthWatch = createHealthWatch({
    intervalMs: deps.healthWatch.intervalMs,
    maxAttempts: deps.healthWatch.maxAttempts,
    backoffFactor: deps.healthWatch.backoffFactor,
    // A `noop` healthcheck means "recreate-success implies ready" — there is no
    // probe to run, so such a service is unwatchable by construction (docker's
    // own restart policy covers the containers configured that way).
    listServices: () =>
      Array.from(currentRegistry.values())
        .filter((ms) => !("noop" in ms.config.healthcheck))
        .map((ms) => ms.name),
    probe: async (name) => {
      const ms = currentRegistry.get(name);
      if (!ms) {
        log.debug("health-watch.probe-skipped", { service: name, reason: "not-in-registry" });
        return true;
      }
      return probeOnce(ms.config.healthcheck, deps.healthIO);
    },
    reapply: async (name) => {
      const status = await applySubsetSerialized(new Set([name]));
      // Surface the RESULT on the watchdog's own trail. Without this the only
      // record of why a recovery failed is the driver's line, which carries no
      // attempt number to tie it to the watchdog's back-off sequence.
      const svc = status.services.find((s) => s.name === name);
      log.info("health-watch.reapplied", {
        service: name,
        state: svc?.state ?? "unknown",
        reason: svc?.lastError ?? null,
      });
    },
    isApplyInFlight: () => applyDepth > 0,
  });

  return {
    get registry() {
      return currentRegistry;
    },
    applyAll: async () => serializeApply(() => withFreshOrchestrator(async (o) => o.applyAll())),
    applySubset: async (names) => applySubsetSerialized(names),
    getStatus: () => lastStatus,
    stopHealthWatch: () => healthWatch.stop(),
    reconcile: async () => {
      // A SIGKILLed gateway cannot run a shutdown hook, so native children from
      // the previous process may still hold their ports. Reap before anything
      // tries to bind them.
      await nativeDriver.reapOrphans();
      const status = await serializeApply(() =>
        withFreshOrchestrator(async (o) =>
          reconcileOnBoot({
            drivers,
            registry: currentRegistry,
            orchestrator: { applyAll: () => o.applyAll() },
          }),
        ),
      );
      // Arm the watchdog only once the boot reconcile has settled, so it never
      // races the very apply that is bringing the fleet up. Idempotent.
      healthWatch.start();
      return status;
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
