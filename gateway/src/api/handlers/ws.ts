import type { Server } from "bun";
import type { SessionData } from "../../session-handlers/ws-helpers.js";
import { createEmptySessionData } from "../../session-handlers/ws-helpers.js";

const HTTP_BAD_REQUEST = 400;

export function createWsUpgradeHandler(server: Server<SessionData>): (request: Request) => Response | undefined {
  return (request) => {
    const data: SessionData = createEmptySessionData();
    const upgraded = server.upgrade(request, { data });
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
  };
}
