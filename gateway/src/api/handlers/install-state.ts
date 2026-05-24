import type { InstallState } from "../../admin/install-state.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "gateway", "api", "install-state"]);

export interface InstallStateDeps {
  installState: InstallState;
  currentVersion: string;
}

export type InstallStateHandler = (req: Request) => Promise<Response>;

export function createInstallStateHandler(deps: InstallStateDeps): InstallStateHandler {
  return async (req: Request) => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    try {
      const state = await deps.installState.load();
      const body = {
        bootstrap_complete: state.bootstrap_complete,
        wizard_cursor: state.wizard_cursor,
        unlock_verified: state.unlock_verified,
        installed_version: state.installed_version,
        current_version: deps.currentVersion,
      };
      log.debug("install-state.fetched", { bootstrap_complete: state.bootstrap_complete });
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("install-state.load-failed", { reason });
      return new Response(JSON.stringify({ error: "state-load-failed", reason }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
