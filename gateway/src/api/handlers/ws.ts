import type { Server } from "bun";
import { getLog } from "../../logging/logger.js";
import type { ClientData } from "../../session-handlers/ws-helpers.js";
import { createEmptySessionData } from "../../session-handlers/ws-helpers.js";

const log = getLog(["sentient", "ws", "upgrade"]);
const HTTP_BAD_REQUEST = 400;

export function createWsUpgradeHandler(server: Server<ClientData>): (request: Request) => Response | undefined {
  return (request) => {
    const data: ClientData = createEmptySessionData();
    // Capture optional `?session_id=<id>` so session.configure can resume
    // the named chain. Wire layer reads this in handleSessionConfigure
    // and runs switchFlow.switchTo before the initial empty snapshot.
    try {
      const url = new URL(request.url);
      const sid = url.searchParams.get("session_id");
      if (sid && sid.length > 0) {
        data.resumeSessionId = sid;
        log.debug("ws-upgrade.resume", { resumeSessionId: sid });
      }
    } catch {
      /* malformed URL — proceed without resume */
    }
    const upgraded = server.upgrade(request, { data });
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
  };
}
