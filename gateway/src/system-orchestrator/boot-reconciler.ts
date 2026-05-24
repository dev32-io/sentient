import { getLog } from "../logging/logger.js";
import type { DockerDriver } from "./docker-driver.js";
import type { ManagedService, OrchestratorStatus, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "boot-reconciler"]);

export interface ReconcileDeps {
  driver: DockerDriver;
  registry: Map<ServiceName, ManagedService>;
  orchestrator: { applyAll(): Promise<OrchestratorStatus> };
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<OrchestratorStatus> {
  const known = new Set(deps.registry.keys());
  const live = await deps.driver.listManaged();
  for (const c of live) {
    if (!known.has(c.service)) {
      log.warn("reconcile.orphan-reap", { id: c.id, service: c.service });
      const r = await deps.driver.remove(c.id);
      if (!r.ok) log.warn("reconcile.orphan-remove-failed", { id: c.id, reason: r.error.reason });
    }
  }
  log.info("reconcile.applying", { count: deps.registry.size });
  return deps.orchestrator.applyAll();
}
