import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { handleAuthMessage, scheduleAuthTimeout } from "./ws-auth-gate.js";
import type { SessionData } from "./ws-helpers.js";
import { sendError } from "./ws-helpers.js";
import { handleSessionConfigure } from "./ws-session-configure.js";

export type { SessionData };

export interface GatewayTlsMaterial {
  readonly cert: string;
  readonly key: string;
}

const log = getLog(["sentient", "ws"]);
const WS_NORMAL_CLOSURE = 1000;

// ---------------------------------------------------------------------------
// Session open — auth + session registration
// ---------------------------------------------------------------------------

export function openSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  const result = services.sessionManager.createSession();
  if (!result.ok) {
    sendError(ws, "session_limit", result.error);
    ws.close(WS_NORMAL_CLOSURE, "Session limit reached");
    return;
  }

  ws.data.sessionId = result.value.sessionId;
  ws.data.authTimeout = scheduleAuthTimeout(ws, services.authConfig.ws_auth_timeout_ms);
  log.info("session-opened", { sessionId: result.value.sessionId });
}

// ---------------------------------------------------------------------------
// Message routing — post-purge minimal form.
//
// The full cognitive-cycle message surface (text.input / audio.start /
// audio.end / interrupt / session.new / conversation.activate /
// user.preferences.patch) routed into the Hermes-cycle brain purged in this
// task (see the sibling-directory deletions in the same commit). What
// remains: auth handshake, ping/pong, session.configure (bare accept-and-hold
// form — see ws-session-configure.ts), and session.end. Plan 2 rebuilds the rest.
// ---------------------------------------------------------------------------

export async function handleWebSocketMessage(
  ws: ServerWebSocket<SessionData>,
  message: string | Buffer,
  services: GatewayServices,
): Promise<void> {
  // Binary frames had nowhere to go without the deleted audio input adapter.
  if (typeof message !== "string") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    sendError(ws, "protocol_error", "Malformed JSON");
    return;
  }

  if (ws.data.authState !== "authed") {
    await handleAuthMessage(ws, parsed, services.auth, services.sessionManager);
    return;
  }

  const msgResult = clientMessageSchema.safeParse(parsed);
  if (!msgResult.success) {
    sendError(ws, "protocol_error", `Invalid message: ${msgResult.error.message}`);
    return;
  }
  const msg = msgResult.data;

  if (msg.type !== "ping") {
    log.debug("message-received", { type: msg.type });
  }

  switch (msg.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong" }));
      return;

    case "session.configure":
      // Resume params ride INSIDE the configure frame (msg.resume) — accepted
      // and logged by the handler, not acted on (see ws-session-configure.ts).
      handleSessionConfigure(
        ws,
        msg.capabilities.supports,
        msg.language,
        services,
        msg.clientType,
        msg.deviceId,
        msg.surfaceId,
        msg.resume,
        msg.conversationId,
      );
      return;

    case "session.end":
      handleSessionEnd(ws, services);
      return;

    default:
      // text.input / audio.start / audio.end / interrupt / tool.confirm /
      // session.new / conversation.activate all required deleted
      // infrastructure (input adapters, controllers, sessions handlers).
      // Received but unhandled until Plan 2 rebuilds the native orchestrator.
      log.debug("message-unhandled", { type: msg.type, reason: "orchestrator not yet rebuilt" });
      return;
  }
}

// ---------------------------------------------------------------------------
// Session end + cleanup
// ---------------------------------------------------------------------------

function handleSessionEnd(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  if (!ws.data.sessionId) return;
  cleanupSession(ws, services);
  ws.close(WS_NORMAL_CLOSURE, "Session ended");
}

/**
 * Tears down the bare connection-tracking state this file owns: the auth
 * timeout and the SessionManager registration. There is no pipeline left to
 * dispose (no ACP wire, no attention gate, no device buffer) — everything
 * that used to require the resumable-disconnect / full-teardown split went
 * with the purged Hermes-cycle brain. Plan 2 restores that split once there
 * is orchestrator state worth resuming.
 */
export function cleanupSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  services.sessionManager.unbindUser(sessionId);
  services.sessionManager.removeSession(sessionId);
  ws.data.sessionId = null;

  log.info("session-cleanup", { sessionId });
}
