import type { AudioPrefsPatch } from "@sentient/audio-prefs";
import { clientMessageSchema } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { scopePendingId } from "../store/pending-id-scope.js";
import { type CommandKind, claimInputFloor, mediateCommand } from "./command-mediator.js";
import { closeExpiredCredential, isCredentialExpired } from "./credential-lifetime.js";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";
import {
  type BindOutcome,
  bindSessionRuntime,
  completeAttach,
  completeAttachWithSnapshot,
  detachSession,
  withSessionStore,
} from "./session-binding.js";
import { mintOnFirstMessage } from "./session-id.js";
import { createSttSession } from "./stt-session.js";
import type { SttSession } from "./stt-session.js";
import { handleAuthMessage, scheduleAuthTimeout } from "./ws-auth-gate.js";
import { handleConversationActivate } from "./ws-conversation-activate.js";
import type { SessionData } from "./ws-helpers.js";
import { sendError } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";
import { handleSessionConfigure } from "./ws-session-configure.js";
import { handleSessionNew } from "./ws-session-new.js";

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

// `sessionId` here is the CONNECTION id and nothing else — it dies with this
// socket. The durable conversation the store partitions on is resolved later,
// in `handleSessionConfigure`, and parked on `ws.data.conversationId`.
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
// `text.input` and `interrupt` route to `ws.data.runtime` (a SessionRuntime,
// minted in ws-session-configure.ts), which drives the native ReAct loop and
// streams replies back through `WsTurnEmitter` (ws-turn-emitter.ts).
//
// Voice (Plan 3 Task 2, spec §6) adds the audio path: `audio.start` /
// `audio.end` drive this connection's `SttSession` (stt-session.ts), and
// INBOUND binary frames are mic audio forwarded to it. Inbound and outbound
// binary are separate paths — outbound TTS frames leave through the turn
// emitter, never through this router.
//
// Permission (Plan 3 Task 6, spec §7.1; session-model spec §2.4) adds the L3
// confirm answer: `permission.response` routes into the SESSION's open prompts
// (`answerPermissionPrompt` below), reached through the registry entry this
// connection is attached to. Connection scoping used to BE the isolation
// boundary; with N windows on one session it strands a prompt whose window
// closed, so the boundary moved to the session — which is where it belongs,
// since a session has exactly one principal.
//
// `session.new` (defect D12) answers with `session.created` naming this
// connection's durable conversation — ws-session-new.ts. `conversation.activate`
// (session-model plan task 4) answers `session.switched` after a membership
// lookup — ws-conversation-activate.ts.
//
// COMMAND BINDING (task 9, spec §3.7/§3.6/§8.3) puts ONE gate in front of every
// acting arm below: `mediateCommand` (command-mediator.ts) revalidates the
// credential, checks the `{sessionId, generation}` the client stamped against
// this connection's CURRENT attachment, and arbitrates simultaneous input. The
// arms do not re-implement any part of that and must not start to — scattered
// verb-style checks is how a bypass appears, and "cancel is only a cancel so it
// can go straight to the runtime" is that shape. `session.configure`,
// `session.new` and `conversation.activate` are deliberately outside it: they
// are how a connection LEAVES a session, so binding them to the one being left
// would make switching unreachable.
// ---------------------------------------------------------------------------

export async function handleWebSocketMessage(
  ws: ServerWebSocket<SessionData>,
  message: string | Buffer,
  services: GatewayServices,
): Promise<void> {
  // ── CREDENTIAL, BEFORE ANYTHING ELSE (spec §3.6, credential-lifetime.ts) ──
  //
  // At the ENTRY rather than inside `mediateCommand`, because the mediator
  // covers only the ACTING commands: `session.configure`, `session.new`,
  // `conversation.activate`, the preference write and raw binary audio all pass
  // it by. Those are exactly the frames that RE-ATTACH a socket, so a check
  // that misses them can be undone by the very next frame — an expired socket
  // would reopen an owned session and take its snapshot. One check here covers
  // every inbound frame; the mediator's own phase 1 shares this predicate and
  // stays for the spoken path, which is mediated later, at the transcript.
  //
  // Pre-auth this is a no-op: `tokenExpiresAtMs` is null until the auth gate
  // sets it, so the `auth` frame itself can never be closed by it.
  if (isCredentialExpired(ws)) {
    detachSession(ws, services);
    closeExpiredCredential(ws, "inbound");
    return;
  }

  // Inbound binary = mic audio → STT (spec §6). Never routed through the
  // outbound emitter. Dropped before auth completes: unauthenticated bytes
  // must not reach the STT service running on the operator's host.
  if (typeof message !== "string") {
    if (ws.data.authState !== "authed") {
      log.warn("binary-frame-preauth", {
        sessionId: ws.data.sessionId,
        byteSize: message.byteLength,
        reason: "audio frame arrived before auth completed",
      });
      return;
    }
    ws.data.stt?.pushFrame(message);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    sendError(ws, "protocol_error", "Malformed JSON");
    return;
  }

  if (ws.data.authState !== "authed") {
    await handleAuthMessage(ws, parsed, services.auth, services.sessionManager, services.authenticatedSockets);
    return;
  }

  const msgResult = clientMessageSchema.safeParse(parsed);
  if (!msgResult.success) {
    sendError(ws, "protocol_error", `Invalid message: ${msgResult.error.message}`);
    return;
  }
  const msg = msgResult.data;

  if (msg.type !== "ping") {
    // THE COMMAND LINE (session-model spec §7.3). With N windows on one
    // session, `sessionId` alone no longer says WHO acted — two tabs of one
    // person are two attachments on one conversation — so every command line
    // carries `attachmentId` and its `generation` too. Without it an
    // unattributed Stop cannot be traced back to the window that sent it.
    log.debug("message-received", {
      type: msg.type,
      connectionId: ws.data.sessionId,
      sessionId: ws.data.conversationId,
      attachmentId: ws.data.attachment?.attachmentId ?? null,
      generation: ws.data.attachment?.generation ?? null,
    });
  }

  switch (msg.type) {
    case "ping":
      // CONNECTION lane (frame-lanes.ts): a transport-liveness ack with no
      // payload, belonging to this socket alone. Never journaled — a periodic
      // keepalive in a SHARED seq space would burn seq numbers for every window
      // and evict real content from the byte-capped journal — and never fanned
      // out, because another window's ping is not this one's business.
      sendConnectionFrame(ws, { type: "pong" });
      return;

    case "session.configure": {
      // NO AUTHORITY GATE HERE, DELIBERATELY. It lives at the MINT
      // (`bindSessionRuntime`, session-binding.ts), which every arm that turns
      // `ws.data.principal` into a capability must go through — this one,
      // `conversation.activate`, and the late re-bind under `text.input`. A
      // gate per arm is whack-a-mole: the next arm added reopens the hole.
      // Resume params ride INSIDE the configure frame (msg.resume) — the
      // handler acquires this surface's frame journal and answers with the
      // stream.resumed decision (Plan 3 Task 10, see ws-session-configure.ts).
      // `msg.conversationId` is the client's optional anchor for the DURABLE
      // conversation; the handler validates it against this principal and
      // resolves the store partition from it (or from the surface).
      await handleSessionConfigure(
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
    }

    case "text.input": {
      if (!mediate(ws, services, msg, "text.input", msg.pendingId)) return;
      // MINT ON FIRST MESSAGE (spec §4.2). A draft connection has no session
      // and no runtime; this is the moment the id is allocated and the row
      // written. Idempotent by mint key, so a retry after a lost
      // `session.created` reaches the session it already created rather than
      // forking a second one.
      const bound = await ensureBoundRuntime(ws, services, msg.text);
      // A refused bind already told this socket `auth.error` and closed it.
      // Answering `orchestrator_unavailable` on top would be a second, false
      // explanation for the same event.
      if (bound.kind === "refused") return;
      if (bound.kind !== "bound") {
        sendError(ws, "orchestrator_unavailable", "Native orchestrator is not available for this session");
        return;
      }
      const runtime = bound.runtime;
      // `pendingId` is threaded, NOT acted on here: the idempotency decision
      // belongs where the store append happens (SessionRuntime), so a resend
      // is recorded and re-echoed rather than silently swallowed by the router.
      // It is NAMESPACED by the issuing surface first (spec §3.8) — the dedup
      // record is session-scoped and durable, so with N windows on one session
      // two that reuse a value would silently suppress the second message.
      //
      // THE FLOOR IS CLAIMED HERE, not up at the gate: a claim is made on
      // behalf of an input that is actually going to be submitted, and the two
      // lines above can still fail. Claiming before them burns the floor for a
      // message that ended in `orchestrator_unavailable` and refuses a peer for
      // a dispatch that did nothing (command-mediator.ts).
      // `pendingId` rides along so a `session_busy` refusal names the message it
      // refused. It is the one refusal the protocol calls retryable immediately,
      // so it is the one a client most needs to settle against a specific bubble
      // — and a pendingId-keyed outbox cannot fail the right entry without it.
      if (!claimInputFloor({ type: "text.input", pendingId: msg.pendingId }, ws, services.sessionRegistry)) return;
      runtime.submit({
        kind: "conversational",
        text: msg.text,
        ...(msg.pendingId === undefined ? {} : { pendingId: scopedPendingId(ws, msg.pendingId) }),
      });
      return;
    }

    case "interrupt":
      if (!mediate(ws, services, msg, "interrupt")) return;
      // No-op (not an error) if idle or the orchestrator is unconfigured —
      // interrupt is idempotent and there is nothing to cancel.
      //
      // Its own INFO because Stop is the cancellation §7.3 names: it aborts the
      // turn for EVERY window on the session, so "which window pressed it" is
      // the first question anyone reading the log will have, and the abort
      // itself (runtime/cancellation.ts) knows only the session.
      log.info("interrupt.requested", {
        connectionId: ws.data.sessionId,
        sessionId: ws.data.attachment?.sessionId ?? null,
        attachmentId: ws.data.attachment?.attachmentId ?? null,
        generation: ws.data.attachment?.generation ?? null,
        hasRuntime: ws.data.runtime !== null,
      });
      ws.data.runtime?.interrupt();
      return;

    case "audio.start":
      if (!mediate(ws, services, msg, "audio.start")) return;
      // The mic opened. Lazily dial STT (a text-only session never does) and
      // relay the client's turn authority (manual = hold-to-talk).
      ensureSttSession(ws, services)?.start(msg.turnMode);
      return;

    case "audio.end":
      if (!mediate(ws, services, msg, "audio.end")) return;
      // PTT release / mic off — force-finalize any open STT turn now.
      ws.data.stt?.end();
      return;

    case "permission.response":
      if (!mediate(ws, services, msg, "permission.response")) return;
      answerPermissionPrompt(ws, services, msg.requestId, msg.approved);
      return;

    case "session.new":
      // `intent` separates a person pressing "+" from an app simply launching
      // — see ws-session-new.ts for why answering both the same way forks the
      // conversation on every mobile relaunch.
      handleSessionNew(ws, services, msg.requestId, msg.intent);
      return;

    case "user.preferences.patch":
      // The in-chat mute toggle. Detached on purpose: the frame is
      // fire-and-forget on all three SDKs (none reads a reply), and a profile
      // write must not hold the router. The handler never throws — see
      // handle-preferences-patch.ts.
      applyPreferencesPatch(ws, services, msg.payload);
      return;

    case "conversation.activate":
      // `GET /sessions/:id/messages` (api/handlers/sessions.ts) landed earlier
      // in this same task, which is what makes this frame answerable now — see
      // ws-conversation-activate.ts's header for why it was silently dropped
      // before that: its only reply, session.switched, tells both client SDKs
      // to refetch history over a route that used to not exist, and their
      // fetch-failure branch replaces the mirror with an empty list.
      await handleConversationActivate(ws, services, msg.sessionId);
      return;

    default:
      // Unreached for any type in clientMessageSchema's union — every member
      // has its own case above, which is why TS narrows `msg` to `never` here.
      // Kept as a safety net, not a dispatch table entry: a future protocol
      // addition that forgets a case lands here first, loudly, rather than
      // silently matching a stale case by accident.
      log.debug("message-unhandled", { reason: "no case for this message type" });
      return;
  }
}

/**
 * Put one inbound command through the choke point (spec §3.7).
 *
 * Returns false when the arm must NOT run — the mediator has already logged the
 * reason and sent the client a `command.rejected` frame, so the caller adds
 * nothing by handling it. Returning a boolean rather than the verdict is
 * deliberate: no arm below needs the accepted session id (each already reaches
 * it through `ws.data`), and handing one out invites an arm to act on a session
 * it re-derived rather than the one the gate approved.
 *
 * [binding] is the frame itself; only the two §3.7 fields are read off it.
 */
function mediate(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  binding: { sessionId?: string | undefined; attachmentGeneration?: number | undefined },
  type: CommandKind,
  pendingId?: string,
): boolean {
  return mediateCommand(
    {
      type,
      sessionId: binding.sessionId,
      generation: binding.attachmentGeneration,
      ...(pendingId === undefined ? {} : { pendingId }),
    },
    ws,
    services.sessionRegistry,
  ).accept;
}

/**
 * This connection's `pendingId` store key (spec §3.8).
 *
 * Namespaced by SURFACE, which is the only identifier with the right lifetime:
 * stable across this window's own reconnects (so a resend still matches the
 * durable record) and distinct between windows (so two of them cannot dedup
 * each other's message away). Falls back to the connection id only before
 * `session.configure` has run, where there is no surface to name and no peer
 * window to collide with.
 */
function scopedPendingId(ws: ServerWebSocket<SessionData>, pendingId: string): string {
  return scopePendingId(ws.data.surfaceId ?? ws.data.sessionId ?? "", pendingId);
}

/**
 * Settle one of the SESSION's open permission prompts from the window that
 * answered (session-model spec §2.4).
 *
 * ROUTED BY SESSION, NOT BY SOCKET. The broker used to hang off
 * `ws.data.permissions`, which made "the prompt was minted on this connection"
 * the resolution rule; a prompt raised at the laptop was then unanswerable from
 * the phone. The prompt map belongs to the session's handles now, so the route
 * is: this connection's ATTACHMENT → the session THE ATTACHMENT names → that
 * session's prompts.
 *
 * ONE FIELD, NOT TWO. Both halves — the answering window and the session it may
 * answer for — come off the same `Attachment`. Taking the session from
 * `ws.data.conversationId` instead would pair them through an ordering
 * invariant maintained across every bind, detach and switch: correct today,
 * unenforced, and a divergence away from letting a connection settle a prompt
 * on a session it is not a window on.
 *
 * THE ATTACHMENT IS THE AUTHORITY, and requiring it is what preserves the old
 * isolation exactly. `detachSession` clears it, so a connection that has left
 * (a re-configure, a "+", a `conversation.activate` elsewhere, a close) can no
 * longer answer for a session it is no longer in — even though it may still
 * remember the id. It also supplies the `attachmentId` every settle line
 * carries, because with N windows an unattributed approval cannot be traced.
 *
 * Fail-closed by construction: an unknown, duplicate or already-timed-out
 * requestId settles nothing and re-opens nothing — the broker just returns
 * false and this logs it. Task 9's mediator is where the generation check
 * goes; it is deliberately not duplicated here.
 */
function answerPermissionPrompt(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  requestId: string,
  approved: boolean,
): void {
  const attachment = ws.data.attachment;
  log.info("permission.response.received", {
    connectionId: ws.data.sessionId,
    sessionId: attachment?.sessionId ?? null,
    attachmentId: attachment?.attachmentId ?? null,
    generation: attachment?.generation ?? null,
    requestId,
    approved,
  });

  if (attachment === null) {
    log.warn("permission.response.unattached", {
      connectionId: ws.data.sessionId,
      requestId,
      reason: "this connection is not attached to a session — only a window IN a session can answer its prompts",
    });
    return;
  }

  const sessionId = attachment.sessionId;
  const permissions = services.sessionRegistry.handlesFor(sessionId)?.permissions ?? null;
  if (permissions === null) {
    log.warn("permission.response.no-session", {
      connectionId: ws.data.sessionId,
      sessionId,
      attachmentId: attachment.attachmentId,
      requestId,
      reason: "no session is resident under this id — its prompts were denied when it was released",
    });
    return;
  }

  if (!permissions.resolve(requestId, { allow: approved }, attachment.attachmentId)) {
    log.warn("permission.response.unmatched", {
      connectionId: ws.data.sessionId,
      sessionId,
      attachmentId: attachment.attachmentId,
      requestId,
      reason: "no open prompt for that requestId — another window already answered it, or it timed out",
    });
  }
}

/**
 * The runtime this connection's message goes to — minting the session first if
 * the connection is still a draft, or re-binding one whose handshake could not.
 *
 * NO PATH THROUGH HERE IS PERMANENT. Both ways a connection can arrive without
 * a runtime are retried on the NEXT message, each by the route that lands on
 * the right session:
 *
 *  - **it resolved a session but the bind failed** (no active LLM key at
 *    handshake time) → re-bind that same session;
 *  - **it is a draft** → mint, which is idempotent under the connection's
 *    unchanged draft key, so a failed attempt re-resolves the same row.
 *
 * That symmetry is the point. One transient misconfiguration used to wedge the
 * socket for its whole life at both call sites.
 *
 * WHY THE MINT LIVES HERE. A session is allocated by the first MESSAGE, not by
 * the handshake (spec §4.2): connecting yields an empty draft, so ten opened
 * tabs leave no row behind. This is the only place that sees a message arrive
 * on a draft, so it is the only place that can do it.
 *
 * ORDER on the mint path, and it is deliberate:
 *
 *  1. mint (or re-resolve, on a retry) the session under the connection's
 *     draft key — the `UNIQUE` constraint on `mint_key` is what makes the
 *     retry idempotent, not a read-then-write check;
 *  2. bind the runtime to it;
 *  3. BROADCAST the mint as `session.created` BEFORE the message is submitted,
 *     so the id reaches the client ahead of the turn frames that reference it,
 *     and so a second window already attached to this connection's session
 *     learns the id without re-attaching. Task 6 turns this single send into a
 *     session-lane fan-out; the frame and its position are already correct.
 *
 * Returns the bind's OWN outcome, not a nullable runtime, and the third case is
 * why: `no-runtime` means the orchestrator is absent from config or its
 * per-session construction failed (no active LLM key), and the caller answers
 * `orchestrator_unavailable` — the only signal that a `text.input` went
 * nowhere. `refused` means the mint found this socket's authority no longer
 * matches the record and CLOSED it. Collapsing the two would send
 * `orchestrator_unavailable` to a socket that has already been told
 * `auth.error`, and log a construction failure that never happened — the very
 * line an operator greps during a revocation.
 */
async function ensureBoundRuntime(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  text: string,
): Promise<BindOutcome> {
  if (ws.data.runtime) return { kind: "bound", runtime: ws.data.runtime };

  const principal = ws.data.principal;
  const draftKey = ws.data.draftKey;
  if (principal === null || draftKey === null) {
    log.warn("text.input.unconfigured", {
      sessionId: ws.data.sessionId,
      reason: "no principal or draft key on this connection — session.configure has not run",
    });
    return { kind: "no-runtime" };
  }

  if (ws.data.conversationId !== null) {
    // LATE RE-BIND. This connection resolved a session at handshake time but
    // its runtime failed to construct (no active LLM key for this user, the one
    // per-session failure `bindSessionRuntime` swallows). Retrying HERE, for
    // that same session, is what stops the failure being permanent: the branch
    // used to log and give up, so one transient misconfiguration at configure
    // time made the socket answer `orchestrator_unavailable` for the rest of
    // its life — a key restored a second later changed nothing until the user
    // reloaded.
    //
    // Re-binding rather than clearing the id and minting: the id is the only
    // record of which session the client asked for, and a mint here would
    // silently move them into a brand-new conversation.
    //
    // NO OWNERSHIP CHECK, AND THAT IS THE POINT (task 5). This branch used to
    // decline when another live connection was serving the session, because
    // binding meant CLAIMING it and the claim evicted the incumbent. Attaching
    // takes nothing from anyone: if a second tab opened the same session while
    // this one was wedged, this connection joins that session's runtime and
    // both windows are live in it.
    const rebound = await bindSessionRuntime(ws, services, ws.data.conversationId);
    // A REFUSED bind is propagated verbatim: it has already told the client
    // `auth.error` and closed the socket, and it is NOT a construction failure.
    if (rebound.kind === "refused") return rebound;
    if (rebound.kind !== "bound") {
      log.warn("text.input.no-runtime", {
        sessionId: ws.data.sessionId,
        conversationId: ws.data.conversationId,
        reason: "session is bound but a runtime still could not be constructed for it",
      });
      return rebound;
    }
    // The handshake could not send a feed (it had no runtime to project one
    // from) and sent nothing at all — not even the draft's empty snapshot. This
    // is the client's first chance to see this session's history. Directed at
    // THIS socket: a peer already attached to the session has a correct mirror
    // that a snapshot would replace (session-binding.ts).
    completeAttachWithSnapshot(ws, services);
    // The strip rides beside the committed feed on every attach — see
    // ws-session-configure.ts's `sendConversationSnapshot` for why. Called on
    // the runtime `bindSessionRuntime` just returned, not on `ws.data.runtime`:
    // this branch only runs when the latter was null, and TypeScript cannot see
    // that the bind above reassigned it.
    rebound.runtime.emitTaskList();
    log.info("text.input.late-bind", {
      sessionId: ws.data.sessionId,
      conversationId: ws.data.conversationId,
      reason: "runtime construction failed at session.configure and succeeded on this message",
    });
    return rebound;
  }

  const { sessionId, replayed } = withSessionStore(services, principal, (store) =>
    mintOnFirstMessage({ store, mintKey: draftKey, text }),
  );

  // A REPLAYED mint means two connections presented ONE draft key, and it is
  // not only the lost-ack retry:
  //
  //   sessionStorage is COPIED into a duplicated browsing context (HTML Living
  //   Standard), and the draft key lives in per-tab sessionStorage
  //   (`sentient.currentSessionId`, shared/web-sdk/src/sdk-reconnect.ts). So an
  //   ordinary browser "Duplicate Tab" mid-draft leaves TWO independently
  //   connected sockets on one draft key, both routed onto that draft by
  //   `resolveConnectionSession`. Whichever sends first mints; the other's
  //   first message replays onto the same id.
  //
  // Both connections now ATTACH to that one session and both are served
  // (task 5). This used to be a race with a loser: the second one's bind
  // CLAIMED the session and evicted a fully live tab that might have been
  // mid-turn, and `session.created` is a single-connection send, so the loser
  // never learned it had lost. There is nothing left to arbitrate.

  // Bind BEFORE recording the id on the connection. Assigning first and failing
  // here would leave `conversationId` set with no runtime, and every later
  // `text.input` would take the bound branch above and answer
  // `orchestrator_unavailable` for the rest of the socket's life without ever
  // retrying the bind. Leaving it null costs nothing: the mint is idempotent,
  // so the next message re-resolves the SAME row under the same draft key.
  const bind = await bindSessionRuntime(ws, services, sessionId);
  if (bind.kind === "refused") return bind;
  if (bind.kind !== "bound") {
    log.error("text.input.mint-without-runtime", {
      sessionId: ws.data.sessionId,
      conversationId: sessionId,
      reason:
        "session minted but no runtime could be constructed — connection stays a draft so the next message retries",
    });
    return bind;
  }
  ws.data.conversationId = sessionId;

  sendConnectionFrame(ws, { type: "session.created", sessionId, ts: Date.now() });
  // A REPLAYED mint lands on a connection whose handshake already told it it
  // was a draft and handed it an EMPTY committed feed (session-binding.ts's
  // `sendDraftHandshake`). Without re-projecting the real feed here, the
  // client renders only the retried message and its reply while the earlier
  // exchange stays invisible until a reload — on the exact path this whole
  // design exists to serve. A fresh mint needs no snapshot: an empty feed is
  // the truth there, and the user entry follows immediately. Directed at THIS
  // socket for the same reason as the late bind above — and here a peer is not
  // hypothetical: a replayed mint means a second connection is on this draft.
  // Either way the attach must be COMPLETED — `bindSessionRuntime` left this
  // window held, so without one of these two lines it receives nothing at all.
  if (replayed) {
    completeAttachWithSnapshot(ws, services);
    // Same seam as every other snapshot attach — see ws-session-configure.ts's
    // `sendConversationSnapshot`. Only on this branch: a FRESH mint has no
    // prior turn to have a strip for, which is the same reason it takes
    // `completeAttach` rather than the snapshot variant. Called on the local
    // the bind above returned, for the same narrowing reason as the late-bind
    // path.
    bind.runtime.emitTaskList();
  } else {
    completeAttach(ws, services);
  }
  return bind;
}

/**
 * Lazily mints this connection's STT uplink on the first `audio.start`.
 * Returns null when the gateway has no `stt:` config block at all — a
 * text-capable deployment, not an error. The runtime is read through a
 * getter, not captured, so a re-`session.configure` that re-mints
 * `ws.data.runtime` cannot strand transcripts on a dead runtime.
 */
function ensureSttSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): SttSession | null {
  if (ws.data.stt) return ws.data.stt;
  if (!services.stt) {
    log.warn("audio.start.no-stt", { sessionId: ws.data.sessionId, reason: "no stt: block in config.yaml" });
    return null;
  }
  const session = createSttSession({
    sessionId: ws.data.sessionId ?? "unbound",
    factory: services.stt.adapterFactory,
    config: services.stt.adapterConfig,
    getRuntime: () => ws.data.runtime,
    // A SPOKEN INPUT IS AN INPUT (spec §8.3: "this applies to every input form:
    // mic onset, text, or anything later"), so it goes through the same gate —
    // at the TRANSCRIPT, which is the moment mic bytes become a command.
    //
    // AN EMPTY BINDING, BY CONSTRUCTION: the client never stamped one, so this
    // decides whether the speaker may submit NOW, against the attachment as it
    // stands now. It follows that a transcript can never be refused
    // `stale_generation` — there is no claimed pair to be stale. What stops
    // words captured in the session this connection has LEFT from landing here
    // is `detachSession` discarding the uplink on every leave
    // (session-binding.ts); it is not this call, and it cannot be.
    getRuntimeForInput: async (text) => {
      if (!mediate(ws, services, {}, "transcript")) return null;
      const bound = await ensureBoundRuntime(ws, services, text);
      if (bound.kind !== "bound") return null;
      const runtime = bound.runtime;
      // Same ordering as `text.input`: the floor is claimed only once there is
      // a runtime to submit to.
      if (!claimInputFloor({ type: "transcript" }, ws, services.sessionRegistry)) return null;
      return runtime;
    },
  });
  ws.data.stt = session;
  log.info("stt-session-created", { sessionId: ws.data.sessionId });
  return session;
}

/**
 * Persist + live-apply one audio-preference patch for THIS connection's user.
 *
 * The router already gated on `authState === "authed"`, so the principal is
 * set; the guard exists so a future reordering can never turn a missing
 * principal into a write against an empty user id.
 */
function applyPreferencesPatch(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  patch: AudioPrefsPatch,
): void {
  const principal = ws.data.principal;
  if (!principal) {
    log.warn("user.preferences.patch.no-principal", {
      sessionId: ws.data.sessionId,
      reason: "authed connection without a principal — refusing to write a profile",
    });
    return;
  }
  void handlePreferencesPatch(
    {
      profileStore: services.profileStore,
      userId: principal.userId,
      sessionId: ws.data.sessionId ?? "unbound",
    },
    patch,
  );
}

// ---------------------------------------------------------------------------
// Connection cleanup.
//
// THERE IS NO `session.end` FRAME, and there is deliberately nothing to
// replace it with. A client that is done simply DISCONNECTS, and this runs from
// the socket's close handler. Session liveness is already a derived predicate
// over attached connections plus in-flight work (runtime/session-retention.ts),
// so an explicit end frame was a second path to a state we compute anyway — and
// it had regressed into doing exactly what a disconnect does. The one thing it
// could have added over a disconnect is "and stop the work", which is precisely
// what a background task must NOT do (tools/delegate-task.ts).
// ---------------------------------------------------------------------------

/**
 * Tears down the connection-tracking state this file owns: the auth
 * timeout, the SessionManager registration, this connection's ATTACHMENT to
 * its session, and (Plan 3 Task 2) its `SttSession` — closing that aborts its
 * event stream and releases the socket to the STT service, which no other
 * owner would ever do.
 *
 * DETACH, NOT DISPOSE (task 5). The `SessionRuntime` and the session's open
 * PROMPTS belong to the SESSION, so this drops one subscriber and lets the
 * registry's disposal policy decide what that means. With a second window still
 * attached, the conversation simply carries on there. With none, the policy is
 * the RETENTION PREDICATE (task 8, runtime/session-retention.ts): the session
 * stays resident while a turn, a foreground tool call, a background task, a
 * prompt or an auxiliary task is outstanding, and for `session.retention_ms`
 * after that. This is what stops a closing tab orphaning a running delegated
 * task — the store handle stays open, so the completion can still land.
 *
 * A fresh connection re-opens the SAME session by presenting its id in
 * `session.configure.conversationId`; the gateway checks membership and hands
 * the committed feed and the model's history straight back
 * (ws-session-configure.ts). Nothing in the store is torn down here. A
 * connection that was still a DRAFT when it closed leaves nothing at all
 * behind — no row, no id.
 *
 * The other thing that survives is the SESSION's outbound frame journal. It is
 * released by the handles' own dispose, not here, precisely because it is not
 * this connection's to park: with a peer still attached the session keeps
 * filling it, and with none it is kept for `session.retention_ms`
 * so a reconnect carrying `resume: {epoch, lastSeq}` replays the frames this
 * client missed. An in-flight turn is not resumed — it is aborted if this
 * detach disposes the session — only the already-emitted frames are.
 */
export function cleanupSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  // ABOVE THE GUARD, DELIBERATELY. This is the socket's membership of the live
  // authenticated set (authenticated-sockets.ts) — the enumeration a credential
  // revocation reaches a not-yet-attached window through — and it is keyed on
  // the socket object, not on `ws.data`. The early return below fires on a null
  // `sessionId`, which is precisely what a SECOND close event sees, so a release
  // placed under it would leak the socket for the lifetime of the process on
  // exactly the path that is hardest to notice. `remove` is a no-op for a socket
  // that was never a member, so the unauthenticated close costs nothing.
  services.authenticatedSockets.remove(ws);

  const sessionId = ws.data.sessionId;
  if (!sessionId) return;

  if (ws.data.authTimeout) {
    clearTimeout(ws.data.authTimeout);
    ws.data.authTimeout = null;
  }

  // Leave this connection's session. Keyed on the ATTACHMENT id, so a socket
  // that already detached (a reload whose new session.configure beat this
  // close, a duplicate close event) removes nothing rather than unseating the
  // window that replaced it. Open permission prompts are settled by the
  // handles' own `dispose`, if this is the detach that triggers it.
  detachSession(ws, services);

  ws.data.stt?.close();
  ws.data.stt = null;

  services.sessionManager.unbindUser(sessionId);
  services.sessionManager.removeSession(sessionId);
  const conversationId = ws.data.conversationId;
  ws.data.sessionId = null;
  ws.data.conversationId = null;
  ws.data.draftKey = null;

  log.info("session-cleanup", { sessionId, conversationId });
}
