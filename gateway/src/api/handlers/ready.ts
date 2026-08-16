import { areRequiredManagedServicesReady } from "../../system-orchestrator/managed-service-health-status.js";
import type { OrchestratorStatus } from "../../system-orchestrator/types.js";

/** GET /ready — readiness. Required managed services gate traffic; optional
 * integrations may degrade without taking the unrelated gateway offline. */
export interface ReadyHandlerDeps {
  getActiveConnections: () => number;
  getOrchestratorStatus: () => OrchestratorStatus | null;
}

export function createReadyHandler(deps: ReadyHandlerDeps): (request: Request) => Promise<Response> {
  return async () => {
    const orchestrator = deps.getOrchestratorStatus();
    const connections = deps.getActiveConnections();
    if (orchestrator && !areRequiredManagedServicesReady(orchestrator)) {
      return Response.json({ status: "not-ready", connections }, { status: 503 });
    }
    return Response.json({ status: "ready", connections });
  };
}
