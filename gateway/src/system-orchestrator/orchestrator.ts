import { getLog } from "../logging/logger.js";
import { type DepMap, blockedByFailedDeps, topoOrder } from "./dep-graph.js";
import { type HealthIO, pollHealthy } from "./health.js";
import type {
  LaunchKind,
  ManagedService,
  OrchestratorStatus,
  ServiceDriver,
  ServiceName,
  ServiceState,
  ServiceStatus,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "orchestrator"]);

export interface SystemOrchestratorDeps {
  registry: Map<ServiceName, ManagedService>;
  /** One backend per launch kind. The apply loop dispatches on the service's
   *  own `launch` discriminator, so it never learns which backend it is on. */
  drivers: Record<LaunchKind, ServiceDriver>;
  healthIO: HealthIO;
  pollIntervalMs: number;
  applyTimeoutMs: number;
}

export interface SystemOrchestrator {
  applyAll(): Promise<OrchestratorStatus>;
  applySubset(names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus>;
  getStatus(): OrchestratorStatus;
}

export function createSystemOrchestrator(deps: SystemOrchestratorDeps): SystemOrchestrator {
  let current: OrchestratorStatus = idleStatus(deps.registry);
  let inflight: Promise<OrchestratorStatus> | null = null;

  const start = (targets: ServiceName[], mode: "all" | "subset"): Promise<OrchestratorStatus> => {
    if (inflight) return inflight;
    const promise = runApply(deps, targets, mode, (s) => {
      current = s;
    }).finally(() => {
      inflight = null;
    });
    inflight = promise;
    return promise;
  };

  return {
    applyAll: () => start(Array.from(deps.registry.keys()), "all"),
    applySubset: (names) => start(Array.from(names), "subset"),
    getStatus: () => current,
  };
}

function idleStatus(reg: Map<ServiceName, ManagedService>): OrchestratorStatus {
  return {
    state: "idle",
    services: Array.from(reg.values()).map((ms) => ({
      name: ms.name,
      state: "pending",
      optional: ms.config.optional,
      version: null,
      lastError: null,
    })),
    startedAt: null,
    finishedAt: null,
  };
}

async function runApply(
  deps: SystemOrchestratorDeps,
  targets: ServiceName[],
  mode: "all" | "subset",
  emit: (s: OrchestratorStatus) => void,
): Promise<OrchestratorStatus> {
  const startedAt = Date.now();
  const statuses = new Map<ServiceName, ServiceStatus>();
  for (const ms of deps.registry.values()) {
    statuses.set(ms.name, {
      name: ms.name,
      state: "pending",
      optional: ms.config.optional,
      version: null,
      lastError: null,
    });
  }
  const targetSet = new Set(targets);

  log.info("apply.start", { targets, mode });

  const depMap: DepMap = {};
  for (const ms of deps.registry.values()) depMap[ms.name] = ms.config.depends_on;
  const order = topoOrder(depMap);
  if (!order.ok) {
    log.error("apply.dep-graph-error", { error: order.error });
    const reason = `dependency graph: ${order.error.kind}`;
    for (const s of statuses.values()) {
      statuses.set(s.name, { ...s, lastError: reason });
    }
    const final = finalize(statuses, "failed", startedAt);
    emit(final);
    return final;
  }

  const failedRequired = new Set<ServiceName>();

  for (const name of order.value) {
    if (!targetSet.has(name)) continue;
    const ms = deps.registry.get(name);
    if (!ms) continue;

    const blocked = blockedByFailedDeps(depMap, failedRequired);
    if (blocked.has(name)) {
      mark(statuses, name, "blocked-by-dep");
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "starting");
    emit(snapshot(statuses, "applying", startedAt));

    const recr = await deps.drivers[ms.config.launch].recreate(ms);
    if (!recr.ok) {
      const newState: ServiceState = ms.config.optional ? "degraded" : "failed";
      mark(statuses, name, newState, recr.error.reason);
      if (!ms.config.optional) failedRequired.add(name);
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "health-checking");
    emit(snapshot(statuses, "applying", startedAt));

    const health = await pollHealthy({
      healthcheck: ms.config.healthcheck,
      pollIntervalMs: deps.pollIntervalMs,
      io: deps.healthIO,
    });
    if (!health.ok) {
      const newState: ServiceState = ms.config.optional ? "degraded" : "failed";
      mark(statuses, name, newState, health.error.lastError ?? "health-timeout");
      if (!ms.config.optional) failedRequired.add(name);
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "ready");
    emit(snapshot(statuses, "applying", startedAt));
  }

  const finalState = failedRequired.size > 0 ? "failed" : "ready";
  const final = finalize(statuses, finalState, startedAt);
  emit(final);

  const services = Array.from(statuses.values());
  const counts = {
    ready: services.filter((s) => s.state === "ready").length,
    degraded: services.filter((s) => s.state === "degraded").length,
    failed: services.filter((s) => s.state === "failed").length,
    blocked: services.filter((s) => s.state === "blocked-by-dep").length,
  };
  log.info("apply.complete", { state: finalState, durationMs: Date.now() - startedAt, counts });

  return final;
}

function mark(
  m: Map<ServiceName, ServiceStatus>,
  name: ServiceName,
  state: ServiceState,
  lastError: string | null = null,
): void {
  const cur = m.get(name);
  if (!cur) return;
  const prev = cur.state;
  m.set(name, { ...cur, state, lastError });
  if (prev !== state) {
    log.debug("service.state", { service: name, prev, next: state, lastError });
  }
}

function snapshot(
  m: Map<ServiceName, ServiceStatus>,
  state: OrchestratorStatus["state"],
  startedAt: number,
): OrchestratorStatus {
  return { state, services: Array.from(m.values()), startedAt, finishedAt: null };
}

function finalize(
  m: Map<ServiceName, ServiceStatus>,
  state: OrchestratorStatus["state"],
  startedAt: number,
): OrchestratorStatus {
  return { state, services: Array.from(m.values()), startedAt, finishedAt: Date.now() };
}
