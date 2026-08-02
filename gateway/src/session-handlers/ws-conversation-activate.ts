// conversation.activate — switching which session a LIVE connection is bound
// to, without repeating the whole session.configure handshake (spec §3.5 #3,
// §1; session-model plan task 4).
//
// "Lightweight replacement for the retired session.switch" (shared/protocol's
// own doc on conversationActivateSchema): the client already holds this
// connection's journal and capabilities from its last session.configure, so
// this only needs to move ws.data.conversationId / ws.data.runtime onto a
// DIFFERENT session and answer which one it landed on. No snapshot follows —
// the client re-fetches history over GET /sessions/:id/messages
// (api/handlers/sessions.ts).
//
// WHY THIS WAS UNANSWERED UNTIL THIS TASK. ws-handlers.ts's default arm used
// to leave the frame silently unhandled: its only reply, session.switched,
// told both client SDKs to refetch history over a REST route this gateway did
// not yet serve, and their fetch-failure branch replaces the mirror with an
// EMPTY list — answering would have wiped the visible chat. That route landed
// earlier in this same task, which is what makes this handler safe to wire up
// now.
//
// MEMBERSHIP, NOT TRUST. `resolveSession` (session-id.ts) is the exact lookup
// `session.configure` uses for a client-presented id — opened through THIS
// caller's own capability, so "not yours" and "not there" are the same
// `not_found` answer for free. It also refuses a draft key structurally
// (sessionDraftSchema's other MUST-requirement on this task): a draft key
// fails `isWellFormedSessionId` (neither the minted `s_` prefix nor the
// legacy `c::` one).
//
// SINGLE OWNER, STILL. `services.conversationRuntimes` is the pre-task-5
// single-owner registry — task 5 replaces it with a subscriber set that lets N
// connections attach to one session at once. Until then, activating a session
// another LIVE connection is already serving is DECLINED, not evicted — the
// same stance `ensureBoundRuntime`'s late-bind and mint-race guards take
// (ws-handlers.ts) — rather than tearing down a window that may be mid-turn.

import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { bindSessionRuntime, liveRivalOwner, unbindSession, withSessionStore } from "./session-binding.js";
import { mintDraftKey, resolveSession } from "./session-id.js";
import type { SessionData } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "conversation-activate"]);

export function handleConversationActivate(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  presented: string,
): void {
  const connectionId = ws.data.sessionId;
  const principal = ws.data.principal;
  if (principal === null) {
    log.warn("conversation.activate.unconfigured", {
      sessionId: connectionId,
      reason: "no principal on this connection — auth (or session.configure) has not run",
    });
    sendGatewayFrame(ws, { type: "sessions.error", code: "validation", message: "not authenticated" });
    return;
  }

  const resolution = withSessionStore(services, principal, (store) => resolveSession({ store, presented }));
  if ("rejected" in resolution) {
    log.warn("conversation.activate.refused", {
      sessionId: connectionId,
      userId: principal.userId,
      reason: resolution.rejected,
    });
    sendGatewayFrame(ws, { type: "sessions.error", code: "not_found", message: "unknown session" });
    return;
  }
  const targetSessionId = resolution.sessionId;

  if (targetSessionId === ws.data.conversationId && ws.data.runtime !== null) {
    // Already there and live — a duplicate activate (double-click, a second
    // window opening the row it is already on) needs only the ack, not a
    // pointless dispose-and-rebind of a runtime already serving it.
    log.debug("conversation.activate.noop", { sessionId: connectionId, targetSessionId });
    sendGatewayFrame(ws, { type: "session.switched", sessionId: targetSessionId, ts: Date.now() });
    return;
  }

  const rival = liveRivalOwner(ws, services, targetSessionId);
  if (rival !== null) {
    log.warn("conversation.activate.declined", {
      sessionId: connectionId,
      userId: principal.userId,
      targetSessionId,
      ownerConnectionId: rival,
      reason: "another live connection is already serving this session — refusing to evict it",
    });
    sendGatewayFrame(ws, {
      type: "sessions.error",
      code: "switching",
      message: "this session is already open in another window",
    });
    return;
  }

  // Dispose whatever this connection held BEFORE binding the new session —
  // same order handleSessionConfigure uses for a re-configure onto a
  // different session, and for the same reason: a stale store handle or an
  // open permission prompt from the outgoing session must not leak into the
  // new one.
  const priorSessionId = ws.data.conversationId;
  if (priorSessionId !== null) {
    unbindSession(ws, services, priorSessionId);
  }

  const runtime = bindSessionRuntime(ws, services, targetSessionId);
  // The id is kept even on a bind failure — deliberately, mirroring
  // handleSessionConfigure: it is the only record of which session the client
  // asked for, and a later text.input's late-bind path (ensureBoundRuntime,
  // ws-handlers.ts) retries against exactly this id instead of stranding the
  // connection on the one it just left.
  ws.data.conversationId = targetSessionId;
  ws.data.draftKey = mintDraftKey();
  if (runtime === null) {
    log.warn("conversation.activate.bind-failed", {
      sessionId: connectionId,
      userId: principal.userId,
      targetSessionId,
      reason: "session resolved but no runtime could be constructed for it",
    });
    sendGatewayFrame(ws, {
      type: "sessions.error",
      code: "internal",
      message: "could not activate this session right now",
    });
    return;
  }

  log.info("conversation.activate.switched", { sessionId: connectionId, userId: principal.userId, targetSessionId });
  sendGatewayFrame(ws, { type: "session.switched", sessionId: targetSessionId, ts: Date.now() });
}
