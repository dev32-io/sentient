// session.new — answering the client's "start a chat" (defect D12).
//
// WHY THIS EXISTS AT ALL. Both mobile SDKs gate their outbound message queue
// on the conversation id this answer carries: `SendMessageUseCase.flushIfReady`
// refuses to drain while `attachedId` is null, and `attachedId` is written by
// exactly one thing — `SentientSdk.onSessionAnchored`, driven by
// `session.created` / `session.switched`. While this frame went unanswered,
// every mobile text send died on the device (`flush-skipped
// reason="no-id-attached"`) without ever reaching the socket. Silence was the
// defect; answering is the fix.
//
// WHAT THE ANSWER SAYS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It hands back the DURABLE conversation this connection is already bound to —
// `ws.data.conversationId`, resolved once in `handleSessionConfigure` as
// `c::<userId>::<surfaceId>`. It does NOT mint a fresh store partition, and
// that restraint is the whole design decision:
//
//   - A surface has exactly ONE conversation on 2.0. Multi-conversation
//     (past-chat list, switching, per-conversation history) is deferred as its
//     own project — it needs the sessions REST surface first (docs/native-todo.md
//     § 2). Minting a second partition would create rows nothing can ever list,
//     open or delete.
//   - Mobile fires `session.new` on EVERY launch, not only on "+": the chat
//     route's default `sessionId` is null, and `ChatViewModel.init` turns that
//     into `SwitchConversationUseCase(null)` → `sendNewChat()`. Forking a
//     partition here would therefore hand every relaunch a brand-new empty
//     conversation — the exact "the assistant forgot everything on reload"
//     regression the durable conversation id was introduced to kill (spec §10
//     acceptance #9), and it would fail `reload-convergence` /
//     `restart-persistence` on both platforms.
//
// The honest cost, recorded rather than hidden: tapping "+" clears the client's
// mirror locally but does not reset the server-side thread, so the model still
// carries the earlier turns. That is the same deferral as everything else under
// multi-conversation, and it is written down in docs/native-todo.md § 2.
//
// NO requestId ECHO — CHECKED, NOT ASSUMED. `session.created` carries no
// `requestId` field in the frozen contract, and neither client wants one: both
// resolve their pending mint off the BROADCAST (mobile
// `SessionsConnector.onCreated` completes every waiter; web's `newChat()`
// resolves on the first `created` event). The inbound `requestId` is logged for
// tracing and is otherwise a client-side debounce token.

import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import type { SessionData } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "session-new"]);

/**
 * Answer a `session.new` with the `session.created` naming this connection's
 * durable conversation.
 *
 * Fails closed and LOUDLY: a socket with no conversation bound has not run
 * `session.configure` (or its handshake failed before resolving one), and the
 * only worse answer than a wrong id is no answer at all — the client would sit
 * on a queue that never drains. `sessions.error` is the contract's channel for
 * exactly this, so the composer surfaces a failure instead of hanging.
 */
export function handleSessionNew(ws: ServerWebSocket<SessionData>, requestId: string): void {
  const sessionId = ws.data.sessionId;
  const conversationId = ws.data.conversationId;

  if (conversationId === null) {
    log.warn("session.new.no-conversation", {
      sessionId,
      requestId,
      reason: "no durable conversation on this connection — session.configure has not run or failed to resolve one",
    });
    sendGatewayFrame(ws, {
      type: "sessions.error",
      requestId,
      code: "validation",
      message: "session.new arrived before session.configure bound a conversation to this connection",
    });
    return;
  }

  log.info("session.new.answered", { sessionId, requestId, conversationId });
  sendGatewayFrame(ws, { type: "session.created", sessionId: conversationId, ts: Date.now() });
}
