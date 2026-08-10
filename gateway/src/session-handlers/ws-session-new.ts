// session.new — answering the client's "start a chat" (defect D12).
//
// WHY THIS EXISTS AT ALL. Both mobile SDKs gate their outbound message queue
// on the id this answer carries: `SendMessageUseCase.flushIfReady` refuses to
// drain while `attachedId` is null, and `attachedId` is written by exactly one
// thing — `SentientSdk.onSessionAnchored`, driven by `session.created` /
// `session.switched` / (now) `session.draft`. While this frame went
// unanswered, every mobile text send died on the device (`flush-skipped
// reason="no-id-attached"`) without ever reaching the socket. Silence was the
// defect; answering is the fix.
//
// TWO CALLERS WEAR THE SAME FRAME, AND THEY MEAN DIFFERENT THINGS.
//
// Mobile fires `session.new` on EVERY launch, not only on "+": the chat
// route's default `sessionId` is null, and `ChatViewModel.init` turns that
// into `SwitchConversationUseCase(null)` → `sendNewChat()` — twice per launch.
// Treating that as "+" would abandon the bound session on every app open,
// which is the exact "the assistant forgot everything on reload" regression
// the durable id was introduced to kill (spec §10 acceptance #9) and would
// fail `reload-convergence` / `restart-persistence` on both platforms.
//
// So the frame carries `intent` (shared/protocol/src/sessions.ts), DEFAULTED
// to "implicit" so an old client and the cube keep exactly today's behaviour:
//
//   - **implicit + bound**  → `session.created` naming the session already
//     bound to this connection. Nothing changes; the relaunch reattaches.
//   - **implicit + draft**  → `session.draft` re-issuing THIS connection's
//     existing key. Re-issuing rather than re-minting matters: a relaunch
//     mid-draft must not fork the draft, or the mint key changes and a lost
//     ack can no longer be resolved to the session it already created.
//   - **explicit ("+") on a BOUND connection** → unbind, mint a FRESH draft
//     key, answer `session.draft`. Fresh because the old key may already have
//     been spent; reusing it would resolve the next mint to the session the
//     person just left.
//   - **explicit on a connection that is ALREADY a draft** → keep the existing
//     key and answer with it. "+" on an empty draft is a no-op, and re-minting
//     would move the mint key out from under a first message already in flight.
//
// No row is written and no id is minted on any of these paths; the session is
// allocated only if and when a first message arrives (spec §4.2), so a person
// who taps "+" and walks away leaves the session list untouched.
//
// NO requestId ECHO ON `session.created` — CHECKED, NOT ASSUMED. It carries no
// `requestId` field in the contract, and neither client wants one: both
// resolve their pending mint off the BROADCAST (mobile
// `SessionsConnector.onCreated` completes every waiter; web's `newChat()`
// resolves on the first `created` event). `session.draft` DOES echo it, since
// that frame is also pushed unsolicited at handshake time and a client needs
// to tell the two apart.

import type { SessionNewIntent } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { sendDraftHandshake, unbindSession } from "./session-binding.js";
import { mintDraftKey } from "./session-id.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "session-new"]);

/**
 * Answer a `session.new`.
 *
 * Fails closed and LOUDLY when the connection has not configured at all: it
 * has no draft key either, and the only worse answer than a wrong id is no
 * answer at all — the client would sit on a queue that never drains.
 * `sessions.error` is the contract's channel for exactly this, so the composer
 * surfaces a failure instead of hanging.
 */
export function handleSessionNew(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  requestId: string,
  intent: SessionNewIntent,
): void {
  const sessionId = ws.data.sessionId;
  const boundSessionId = ws.data.conversationId;

  if (ws.data.draftKey === null) {
    log.warn("session.new.unconfigured", {
      sessionId,
      requestId,
      intent,
      reason: "no draft key on this connection — session.configure has not run",
    });
    sendConnectionFrame(ws, {
      type: "sessions.error",
      requestId,
      code: "validation",
      message: "session.new arrived before session.configure ran on this connection",
    });
    return;
  }

  if (intent === "implicit" && boundSessionId !== null) {
    log.info("session.new.reattached", { sessionId, requestId, conversationId: boundSessionId });
    sendConnectionFrame(ws, { type: "session.created", sessionId: boundSessionId, ts: Date.now() });
    return;
  }

  if (intent === "explicit" && boundSessionId !== null) {
    unbindSession(ws, services);
    ws.data.draftKey = mintDraftKey();
    log.info("session.new.unbound", {
      sessionId,
      requestId,
      conversationId: boundSessionId,
      draftKey: ws.data.draftKey,
    });
  }

  log.info("session.new.draft", { sessionId, requestId, intent, draftKey: ws.data.draftKey });
  sendDraftHandshake(ws, ws.data.draftKey, requestId);
}
