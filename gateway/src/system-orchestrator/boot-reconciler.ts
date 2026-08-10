import { getLog } from "../logging/logger.js";
import {
  LAUNCH_KINDS,
  type LaunchKind,
  type ManagedService,
  type OrchestratorStatus,
  type ServiceDriver,
  type ServiceName,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "boot-reconciler"]);

export interface ReconcileDeps {
  drivers: Record<LaunchKind, ServiceDriver>;
  registry: Map<ServiceName, ManagedService>;
  orchestrator: { applyAll(): Promise<OrchestratorStatus> };
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<OrchestratorStatus> {
  const known = new Set(deps.registry.keys());
  for (const kind of LAUNCH_KINDS) {
    await reapBackendOrphans(deps.drivers[kind], kind, known);
  }
  log.info("reconcile.applying", { count: deps.registry.size });
  return deps.orchestrator.applyAll();
}

/** Drop every unit a backend still holds that the registry no longer names —
 *  a service the operator deleted from config.yaml, or one renamed by an
 *  upgrade. Each backend reports and removes in its own terms. */
async function reapBackendOrphans(
  driver: ServiceDriver,
  kind: LaunchKind,
  known: ReadonlySet<ServiceName>,
): Promise<void> {
  for (const unit of await driver.listManaged()) {
    if (known.has(unit.service)) continue;
    log.warn("reconcile.orphan-reap", { id: unit.id, service: unit.service, launch: kind });
    const removed = await driver.remove(unit.id);
    if (!removed.ok) {
      log.warn("reconcile.orphan-remove-failed", { id: unit.id, launch: kind, reason: removed.error.reason });
    }
  }
}
