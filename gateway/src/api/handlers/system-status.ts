import { getLog } from "../../logging/logger.js";
import type { OrchestratorStatus } from "../../system-orchestrator/types.js";

const log = getLog(["sentient", "gateway", "api", "system-status"]);

export interface SystemStatusDeps {
  systemOrchestrator: { getStatus(): OrchestratorStatus } | null;
}

export type SystemStatusHandler = (req: Request) => Promise<Response>;

export function createSystemStatusHandler(deps: SystemStatusDeps): SystemStatusHandler {
  return async (req: Request) => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!deps.systemOrchestrator) {
      log.warn("system-status.orchestrator-unavailable");
      return new Response(JSON.stringify({ error: "orchestrator-unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = deps.systemOrchestrator.getStatus();
    log.debug("system-status.returned", {
      state: status.state,
      serviceCount: status.services.length,
    });

    return new Response(JSON.stringify(status), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
