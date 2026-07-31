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
  /** How long a native launch waits for its port to be released by the previous
   *  holder, and how often it re-checks. From `config.yaml#system_orchestrator`;
   *  see native-driver.ts's `waitForPortFree` for why launching onto a held
   *  socket is never acceptable. */
  nativePortSettle: {
    timeoutMs: number;
    pollMs: number;
  };
}

/** The one `ManagedProcessInfo.state` that counts as alive. A backend protocol
 *  string (docker's container state, the native driver's own literal), not a
 *  tunable. */
const RUNNING_UNIT_STATE = "running";

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
  const nativeDriver = createNativeDriver(createNativeIO({ runDir: deps.nativeRunDir }), {
    portSettleTimeoutMs: deps.nativePortSettle.timeoutMs,
    portSettlePollMs: deps.nativePortSettle.pollMs,
  });
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

  /**
   * Backend-level liveness for a service that declares no probe of its own.
   *
   * `healthcheck: noop` means "recreate-success implies ready" — there is no
   * host-reachable port to dial (egress-proxy, searxng, fetch-mcp,
   * searxng-mcp all sit behind a proxy). Those four used to be filtered OUT of
   * the watch list on the grounds that docker's `unless-stopped` policy
   * restarts them. That is true of a container that CRASHED and false of one
   * that was never CREATED — which is exactly what a boot whose apply failed
   * (docker's daemon still starting, a template that would not load) leaves
   * behind, and nothing else ever retries it. So they are watched too, and the
   * probe is the backend's OWN view of the unit rather than a network round
   * trip: present and running, or the watchdog re-applies.
   */
  async function isUnitRunning(ms: ManagedService): Promise<boolean> {
    const units = await drivers[ms.config.launch].listManaged();
    const running = units.some((u) => u.service === ms.name && u.state === RUNNING_UNIT_STATE);
    log.debug("health-watch.unit-probe", { service: ms.name, launch: ms.config.launch, running });
    return running;
  }

  // ── Post-boot health watchdog ─────────────────────────────────────────────
  // apply() runs at boot, from the admin endpoint and from the wizard — never
  // when a service dies later. This is the other half of "restart on crash".
  const healthWatch = createHealthWatch({
    intervalMs: deps.healthWatch.intervalMs,
    maxAttempts: deps.healthWatch.maxAttempts,
    backoffFactor: deps.healthWatch.backoffFactor,
    // EVERY registry entry, `noop` healthchecks included — see `isUnitRunning`.
    listServices: () => Array.from(currentRegistry.keys()),
    probe: async (name) => {
      const ms = currentRegistry.get(name);
      if (!ms) {
        log.debug("health-watch.probe-skipped", { service: name, reason: "not-in-registry" });
        return true;
      }
      const live =
        "noop" in ms.config.healthcheck
          ? await isUnitRunning(ms)
          : await probeOnce(ms.config.healthcheck, deps.healthIO);
      if (!live) return false;
      // Same contract the apply path gates on: liveness AND identity. Without
      // this the watchdog would keep declaring a service healthy for as long as
      // ANY process held its port, so a foreign listener would suppress
      // recovery forever instead of triggering it.
      const identity = await drivers[ms.config.launch].verifyIdentity(ms);
      if (identity.ok) return true;
      log.warn("health-watch.identity-failed", { service: name, reason: identity.error.reason });
      return false;
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
      // ARMING THE WATCHDOG IS UNCONDITIONAL — hence the `finally`, not a line
      // after the apply. The watchdog is the ONLY thing that recovers a service
      // after boot, and a boot that went wrong is exactly when it is needed
      // most. When a failure here could skip it, one unreachable docker daemon
      // (launchd starts the gateway before auto-login starts Docker Desktop)
      // left the whole fleet — including the native addons docker has nothing
      // to do with — with no crash recovery for the entire process lifetime.
      // The two throwing paths are closed at their source as well
      // (docker-driver's `listManaged`, service-registry's template read); this
      // is the structural guarantee that no third one can reopen the hole.
      //
      // Ordering is still respected on the happy path: `start()` runs after the
      // apply has settled, so the watchdog never races the bringup, and it is
      // idempotent.
      try {
        // A SIGKILLed gateway cannot run a shutdown hook, so native children
        // from the previous process may still hold their ports. Reap before
        // anything tries to bind them.
        await nativeDriver.reapOrphans();
        return await serializeApply(() =>
          withFreshOrchestrator(async (o) =>
            reconcileOnBoot({
              drivers,
              registry: currentRegistry,
              orchestrator: { applyAll: () => o.applyAll() },
            }),
          ),
        );
      } finally {
        healthWatch.start();
      }
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
