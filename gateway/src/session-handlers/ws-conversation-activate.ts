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
// N ATTACHMENTS, NO ARBITRATION (task 5). This handler used to DECLINE a
// session another live connection was already serving, answering
// `sessions.error{code:"switching"}`, because binding meant claiming it from
// the single-owner registry and the claim tore that connection down. Attaching
// takes nothing from anyone: opening the same conversation in a second window
// is now the feature, not a collision, so there is no rival to detect and no
// reason to refuse.

import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { bindSessionRuntime, completeAttachWithSnapshot, unbindSession, withSessionStore } from "./session-binding.js";
import { mintDraftKey, resolveSession } from "./session-id.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "conversation-activate"]);

export async function handleConversationActivate(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  presented: string,
): Promise<void> {
  const connectionId = ws.data.sessionId;
  const principal = ws.data.principal;
  if (principal === null) {
    log.warn("conversation.activate.unconfigured", {
      sessionId: connectionId,
      reason: "no principal on this connection — auth (or session.configure) has not run",
    });
    sendConnectionFrame(ws, { type: "sessions.error", code: "validation", message: "not authenticated" });
    return;
  }

  const resolution = withSessionStore(services, principal, (store) => resolveSession({ store, presented }));
  if ("rejected" in resolution) {
    log.warn("conversation.activate.refused", {
      sessionId: connectionId,
      userId: principal.userId,
      reason: resolution.rejected,
    });
    sendConnectionFrame(ws, { type: "sessions.error", code: "not_found", message: "unknown session" });
    return;
  }
  const targetSessionId = resolution.sessionId;

  if (targetSessionId === ws.data.conversationId && ws.data.runtime !== null) {
    // Already there and live — a duplicate activate (double-click, a second
    // window opening the row it is already on) needs only the ack, not a
    // pointless dispose-and-rebind of a runtime already serving it.
    log.debug("conversation.activate.noop", { sessionId: connectionId, targetSessionId });
    sendConnectionFrame(ws, { type: "session.switched", sessionId: targetSessionId, ts: Date.now() });
    return;
  }

  // Leave the outgoing session BEFORE joining the new one — same order
  // handleSessionConfigure uses for a re-configure, and for the same reason:
  // holding two attachments means this connection's close releases only one,
  // pinning the other session resident forever.
  if (ws.data.conversationId !== null) {
    unbindSession(ws, services);
  }

  // Attaches AND holds this window (session-binding.ts). Every path out of here
  // must therefore finish the attach, or this connection silently receives
  // nothing from the session it just switched to.
  const bind = await bindSessionRuntime(ws, services, targetSessionId);
  // The socket is already closed and told why — say nothing more, and do not
  // record a session on a connection that is going away.
  if (bind.kind === "refused") return;
  const runtime = bind.kind === "bound" ? bind.runtime : null;
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
    sendConnectionFrame(ws, {
      type: "sessions.error",
      code: "internal",
      message: "could not activate this session right now",
    });
    return;
  }

  // No committed SNAPSHOT here by design — the client REST-refetches history on
  // `session.switched`, and a second source of truth for the same mirror would
  // race it. The TURN STATE is a different question and is sent: opening a
  // conversation that is mid-reply is the ordinary case for this frame, and no
  // REST route carries `turn.started`, the text so far or an open prompt —
  // without them this window renders deltas for a turn it never saw start.
  completeAttachWithSnapshot(ws, services, "client-refetch");
  // The strip is the same kind of answer, for the same reason — see
  // ws-session-configure.ts's `sendConversationSnapshot`. It matters MOST here:
  // a switch is exactly when the client cleared its own strip
  // (TaskListConnector.clear), and the projector only re-emits on its own
  // mutations, so without this a mid-turn conversation with a running tool
  // shows an empty strip until the next tool event.
  ws.data.runtime?.emitTaskList();
  log.info("conversation.activate.switched", { sessionId: connectionId, userId: principal.userId, targetSessionId });
  sendConnectionFrame(ws, { type: "session.switched", sessionId: targetSessionId, ts: Date.now() });
}
