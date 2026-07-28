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
// Message routing.
//
// The full cognitive-cycle message surface (text.input / audio.start /
// audio.end / interrupt / session.new / conversation.activate /
// user.preferences.patch) used to route into the Hermes-cycle brain purged
// in an earlier task (see the sibling-directory deletions in that commit).
// Plan 2 Task 10 rebuilds the text-only slice of it: `text.input` and
// `interrupt` now route to `ws.data.runtime` (minted in
// ws-session-configure.ts), which drives the native ReAct loop and streams
// replies back through `WsTurnEmitter` (ws-turn-emitter.ts). audio.start /
// audio.end / session.new / conversation.activate remain unhandled — voice
// and multi-conversation routing are Plan 3.
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

    case "text.input":
      if (!ws.data.runtime) {
        log.warn("text.input.no-runtime", {
          sessionId: ws.data.sessionId,
          reason: "orchestrator unconfigured, or session.configure has not run / failed to mint a runtime",
        });
        sendError(ws, "orchestrator_unavailable", "Native orchestrator is not available for this session");
        return;
      }
      ws.data.runtime.submit({ kind: "conversational", text: msg.text });
      return;

    case "interrupt":
      // No-op (not an error) if idle or the orchestrator is unconfigured —
      // interrupt is idempotent and there is nothing to cancel.
      ws.data.runtime?.interrupt();
      return;

    default:
      // audio.start / audio.end / permission.response / session.new /
      // conversation.activate all required deleted infrastructure (input
      // adapters, controllers, sessions handlers) or belong to later Plan 3
      // tasks: voice owns audio.* (Task 2), the permission PDP owns
      // permission.response (Task 6), multi-conversation is unscheduled.
      // Received but unhandled.
      log.debug("message-unhandled", { type: msg.type, reason: "plan 3" });
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
 * Tears down the connection-tracking state this file owns: the auth
 * timeout, the SessionManager registration, and (Plan 2 Task 10) the
 * per-session `SessionRuntime` minted in ws-session-configure.ts.
 * `runtime.dispose()` aborts any in-flight turn's AbortSignal and closes
 * the session's store handle — idempotent, so a socket that never reached
 * session.configure (runtime still null) is unaffected. There is no
 * resumable-disconnect handling yet — a fresh connection always mints a
 * fresh runtime; Plan 3 revisits reconnect/resume for the orchestrator.
 */
export function cleanupSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  ws.data.runtime?.dispose();
  ws.data.runtime = null;

  services.sessionManager.unbindUser(sessionId);
  services.sessionManager.removeSession(sessionId);
  ws.data.sessionId = null;

  log.info("session-cleanup", { sessionId });
}
