// Attaching a connection to a session — the orchestrator handles, in one place.
//
// Extracted from `ws-session-configure.ts` because the bind no longer happens
// only at handshake time. A connection that presents no session id is a DRAFT
// (spec §4.2): no row, no id, no runtime. The id is minted when the first
// message arrives, and the runtime is built THEN — so the same construction
// has two callers (`handleSessionConfigure` on a re-opened session,
// `ws-handlers.ts` on the first message of a draft) and belongs in neither.
//
// ATTACH, NOT CLAIM (session-model plan task 5). This file used to make the
// binding connection the SOLE owner of the session's runtime, evicting whoever
// held it before. It now attaches to a subscriber set: the first attachment
// BUILDS the session's handles, every later one JOINS them, and the runtime is
// released only when the registry's disposal policy says so
// (session-registry.ts). `bindSessionRuntime` is the `build` callback the
// registry invokes on that first attachment; keeping the construction as one
// function with one set of dependencies is what made that a local change.

import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { createTurnVoice } from "../runtime/turn-voice.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { attachWithSnapshot, createFanOutTurnEmitter } from "./fan-out-emitter.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import type { Attachment, SessionHandles } from "./session-registry.js";
import { createSessionVoicePrefs } from "./session-voice-prefs.js";
import type { SessionData } from "./ws-helpers.js";
import { errorMessage } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "session-binding"]);

/**
 * Open the session store this principal's capability selects, hand it to
 * [use], and close it again.
 *
 * SHORT-LIVED ON PURPOSE. The membership lookup (session-id.ts) and the mint
 * both need a store before any `SessionRuntime` exists to own one, and a
 * handle parked on the connection would be a second live `bun:sqlite` handle
 * on the same WAL for the whole session. Opening is cheap; outliving the
 * question is not.
 *
 * The grant is the authorization step: `AccessManager` mints the capability
 * from the principal, and `openSessionStore` refuses any capability that is
 * not for the `session-store` resource class.
 *
 * Takes only the slice of `GatewayServices` it actually reads — `accessManager`
 * — so a caller with a narrower deps shape (the sessions REST handler has no
 * reason to carry the whole services object) can still use it. Every existing
 * caller passes the full `GatewayServices`, which satisfies the narrower type
 * structurally, so this is a widening, not a breaking change.
 */
export function withSessionStore<T>(
  services: Pick<GatewayServices, "accessManager">,
  principal: UserPrincipal,
  use: (store: SessionStore) => T,
): T {
  const store = openSessionStore(services.accessManager.grant(principal, "session-store"));
  try {
    return use(store);
  } finally {
    store.close();
  }
}

/**
 * Attach this connection to [sessionId] and park the session's handles on the
 * socket. Returns the live runtime, or null when none could be produced.
 *
 * ONE RUNTIME, N ATTACHMENTS. The construction below runs only on the FIRST
 * attachment — the registry hands every later connection the SAME handles back,
 * which is what makes a second window a window rather than a second ReAct loop
 * over one append-only log (session-registry.ts's header).
 *
 * Returning the runtime rather than a boolean is not sugar: TypeScript cannot
 * see that this call mutates `ws.data.runtime`, so a caller that checked a
 * boolean and then read the field back would be narrowing against a stale
 * view of it.
 *
 * Never throws. A construction failure is a per-session misconfig (no active
 * LLM key resolved from the secrets store — see `phase-services.ts`'s
 * `buildCreateSessionRuntime`), not a reason to fail the handshake or drop the
 * message: the socket stays usable for everything that does not need the
 * orchestrator, and `text.input` surfaces `orchestrator_unavailable` itself at
 * the point the client actually tries to use it.
 */
export function bindSessionRuntime(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  sessionId: string,
): SessionRuntime | null {
  const connectionId = ws.data.sessionId;
  const principal = ws.data.principal;
  if (connectionId === null || principal === null) {
    log.warn("session-binding.no-principal", {
      sessionId,
      reason: "bind attempted on a connection that has not authenticated",
    });
    return null;
  }
  const userId = principal.userId;

  if (!services.createSessionRuntime) {
    log.info("session-binding.no-orchestrator", { connectionId, userId, reason: "orchestrator: absent from config" });
    return null;
  }

  if (ws.data.attachment !== null) {
    // UNREACHABLE while the invariant below holds: an attachment is non-null
    // only while `conversationId` names the session it is attached to, and
    // every caller detaches before re-binding. Recovering rather than
    // asserting because a leaked attachment holds a session resident for the
    // life of the process. Safe in the worst case: detaching an id the target
    // session never held is a no-op in both the window set and the registry.
    log.warn("session-binding.stale-attachment", {
      connectionId,
      sessionId,
      attachmentId: ws.data.attachment.attachmentId,
      reason: "this connection was still attached when it re-bound — detaching first",
    });
    detachSession(ws, services);
  }

  let attachment: Attachment;
  try {
    attachment = services.sessionRegistry.attach(sessionId, connectionId, ws, () =>
      buildSessionHandles(services, principal, sessionId, connectionId),
    );
  } catch (err) {
    log.error("session-binding.runtime-construction-failed", {
      connectionId,
      userId,
      sessionId,
      reason: errorMessage(err, "unknown error"),
    });
    return null;
  }

  const handles = services.sessionRegistry.handlesFor(sessionId);
  if (handles === null) {
    // Unreachable: `attach` either registers the session or throws. Logged
    // rather than asserted because a null here would otherwise surface as a
    // TypeError inside a detached turn promise.
    log.error("session-binding.no-handles-after-attach", {
      connectionId,
      userId,
      sessionId,
      reason: "registry accepted the attachment but holds no handles for this session",
    });
    return null;
  }

  // HELD IMMEDIATELY, in the same synchronous block as the attach — the
  // linearization point (spec §7.1). The registry has just put this socket in
  // the session's delivery set, so without this line a frame emitted before the
  // snapshot is written to a window whose client has no `turn.started` to hang
  // it on; with it, that frame is buffered and drained after the snapshot,
  // exactly once and in order. Every caller MUST finish the attach —
  // `completeAttachWithSnapshot` or `completeAttach` — or this window receives
  // nothing at all.
  handles.fanOut.hold(attachment.attachmentId);
  ws.data.attachment = attachment;
  ws.data.runtime = handles.runtime;
  ws.data.permissions = handles.permissions;
  ws.data.voicePrefs = handles.voicePrefs;
  // The SESSION's journal and epoch, not this connection's: one seq space, N
  // cursors. Held on the socket so the resume handshake (ws-resume.ts) can ask
  // it what this client missed without re-deriving the session.
  ws.data.journal = handles.journal;
  ws.data.epoch = handles.epoch;
  // The ONE line per attach: the registry, the subscriber set and the window
  // set all log at DEBUG, and repeating these ids four times said nothing the
  // first did not.
  log.info("session-binding.attached", {
    connectionId,
    userId,
    sessionId,
    attachmentId: attachment.attachmentId,
    generation: attachment.generation,
    subscribers: services.sessionRegistry.subscribers(sessionId).length,
  });
  return handles.runtime;
}

/**
 * Construct everything a session owns while it is resident. The registry's
 * `build` callback — invoked on the first attachment ONLY, so nothing here may
 * assume it runs once per connection.
 *
 * [ws] is only the connection that happened to be first, and NOTHING built
 * here may capture it: the session outlives it. The emitter writes to
 * `windows` (every attached socket) and the mic echo guard reads its
 * `SttSession`s the same way, so this argument supplies the connection id for
 * log correlation and nothing else.
 */
function buildSessionHandles(
  services: GatewayServices,
  principal: UserPrincipal,
  sessionId: string,
  connectionId: string,
): SessionHandles {
  // ONE journal per session, acquired with the session's handles and released
  // when they are disposed. The registry keeps it for the retention window
  // afterwards, which is what lets a reconnecting window replay what it missed
  // even though the runtime that produced those frames is long gone.
  const acquisition = services.replayRegistry.acquire(sessionId);
  const fanOut = createFanOutTurnEmitter({
    registry: services.sessionRegistry,
    sessionId,
    journal: acquisition.journal,
    epoch: acquisition.epoch,
    maxLagBytes: services.session.max_window_lag_bytes,
  });
  const emitter = fanOut;
  // Voice composition (spec §6). Built HERE because this is the only place
  // that knows the emitter, the authenticated user's profile and the session's
  // STT session — but DRIVEN inside SessionRuntime on the turn's own
  // AbortController, so barge-in and interrupt cancel TTS through the same
  // abort that stops the provider stream. See turn-voice.ts. Parked on every
  // attached socket too: `user.preferences.patch` applies a live mute toggle
  // through it (handle-preferences-patch.ts).
  const voicePrefs = createSessionVoicePrefs(services.profileStore, principal.userId, connectionId);
  // Every attached window's mic, read at TTS-start time — the session's TTS
  // reaches all of them, so a guard scoped to this one connection would leave
  // the others open on the assistant's own voice (self-triggered barge-in).
  const echoGuard = createMicEchoGuard(
    () => fanOut.sockets.flatMap((window) => (window.data.stt === null ? [] : [window.data.stt])),
    services.stt?.adapterConfig.ttsEchoCooldownMs ?? null,
    sessionId,
  );
  const synthesizer = services.createSynthesizerFor(() => voicePrefs.voiceId());
  const voice = synthesizer
    ? createTurnVoice({
        synthesizer,
        sink: emitter,
        echoGuard,
        shouldSpeak: () => voicePrefs.shouldSpeak(),
        sessionId,
      })
    : null;
  // `createSessionRuntime` is non-null here — `bindSessionRuntime` checks it
  // before calling `attach`, and this closure runs synchronously inside that
  // call.
  const built = services.createSessionRuntime?.({
    principal,
    conversationId: sessionId,
    connectionId,
    emitter,
    voice,
  });
  if (built === undefined) throw new Error("orchestrator is not configured for this gateway");

  log.debug("session-binding.session-handles-built", {
    connectionId,
    userId: principal.userId,
    sessionId,
    hasVoice: voice !== null,
  });
  return {
    runtime: built.runtime,
    permissions: built.permissions,
    voicePrefs,
    fanOut,
    journal: acquisition.journal,
    epoch: acquisition.epoch,
    replayLease: acquisition.lease,
    // Permissions settle BEFORE the runtime is disposed: each open prompt is a
    // promise the ReAct loop is awaiting inside `broker.dispatch`, and an
    // unsettled one parks that turn for the full permission timeout.
    dispose() {
      built.permissions.denyAll();
      built.runtime.dispose();
      // LAST, after everything that can still emit has stopped: the release
      // starts the journal's retention clock, and every frame disposal wrote
      // must already be in it for a reconnecting client to replay.
      services.replayRegistry.release(acquisition.lease);
    },
  };
}

/**
 * Drop this connection's attachment to the session it is on and clear the
 * session's handles off the socket.
 *
 * IT DOES NOT DISPOSE. The runtime belongs to the session, not to this
 * connection; whether losing this attachment ends the session is the
 * registry's disposal policy's decision (today: the last one out disposes;
 * task 8: a retention predicate). That separation is the whole cutover —
 * a connection disposing the runtime it happens to hold IS the eviction this
 * task deleted.
 *
 * Four callers, one body: a re-`session.configure`, an explicit "+", a
 * `conversation.activate` onto a different session, and `cleanupSession`. All
 * must leave the socket in the same state — no attachment, no runtime, no
 * permission broker — so `text.input` answers `orchestrator_unavailable`
 * (ws-handlers.ts) instead of feeding a session it has left.
 *
 * Reads the session id off `ws.data.conversationId` rather than taking it as a
 * parameter: every caller passed exactly that, and a caller that passed
 * anything else would detach from a session this connection never joined.
 */
export function detachSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  const attachment = ws.data.attachment;
  const sessionId = ws.data.conversationId;
  if (attachment !== null && sessionId !== null) {
    // ONE removal, not two: the socket lives IN the subscriber set now, so
    // dropping the attachment drops the delivery target with it. Task 5 had to
    // keep a parallel window map in step by hand here.
    services.sessionRegistry.detach(sessionId, attachment.attachmentId);
    log.info("session-binding.detached", {
      connectionId: ws.data.sessionId,
      sessionId,
      attachmentId: attachment.attachmentId,
      subscribers: services.sessionRegistry.subscribers(sessionId).length,
    });
  }
  ws.data.attachment = null;
  ws.data.permissions = null;
  ws.data.runtime = null;
  // Held per connection but OWNED by the session: cleared here so a socket
  // that has left cannot apply a mute toggle to a `TurnVoice` no turn of its
  // own can reach.
  ws.data.voicePrefs = null;
  // Same reasoning for the journal: the OBJECT belongs to the session (and
  // outlives it, in the replay registry's retention window) — this only drops
  // this connection's handle on it, so a socket that has left cannot answer a
  // resume against a session it is no longer in.
  ws.data.journal = null;
  ws.data.epoch = 0;
}

/**
 * Finish this connection's attach by publishing what it needs to render, then
 * letting it start receiving.
 *
 * Three things, one atomic capture (`attachWithSnapshot`, fan-out-emitter.ts):
 * the committed feed DIRECTED at this connection, the in-flight turn's state,
 * and the drain of everything buffered since the hold.
 *
 * DIRECTED, and the lane table now enforces it. `conversation.snapshot` is the
 * one frame the runtime emits that is an ANSWER to a connection rather than an
 * event in the conversation: a handshake, a late bind, or a replayed mint asked
 * for it, and only that connection has an empty mirror to fill. Fanning it out
 * replaces every OTHER window's committed mirror — which both SDKs treat as a
 * real session boundary — and it arrives with no paired `session.switched`, so
 * a peer inside its own resume window can arm the stale-resume timer, receive
 * no switch, and drop its stored session id. The conversation would then vanish
 * on that peer's next reconnect. It is a CONNECTION-lane frame (frame-lanes.ts)
 * precisely so the fan-out cannot broadcast it even by accident.
 *
 * Returns false when this connection is not attached, so the caller can log its
 * own reason rather than guess at one.
 */
export function completeAttachWithSnapshot(ws: ServerWebSocket<SessionData>, services: GatewayServices): boolean {
  const sessionId = ws.data.conversationId;
  if (ws.data.runtime === null || ws.data.attachment === null || sessionId === null) return false;
  if (services.sessionRegistry.handlesFor(sessionId) === null) return false;
  attachWithSnapshot(services.sessionRegistry, sessionId, ws);
  return true;
}

/**
 * Finish an attach that does NOT get a snapshot, by draining everything the
 * hold buffered.
 *
 * Two callers, both of which would fight a snapshot rather than benefit from
 * one: a FRESH mint (the committed feed is empty and the user's own entry
 * follows immediately) and `conversation.activate` (the client REST-refetches
 * history on `session.switched`).
 *
 * [deliveredThrough] is the highest seq this connection has ALREADY been sent
 * by another path — the recovered-resume replay's `toSeq`. 0 means "it has seen
 * nothing; drain everything", which is the right answer whenever no replay ran.
 */
export function completeAttach(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  deliveredThrough = 0,
): void {
  const sessionId = ws.data.conversationId;
  const attachment = ws.data.attachment;
  if (sessionId === null || attachment === null) return;
  services.sessionRegistry.handlesFor(sessionId)?.fanOut.release(attachment.attachmentId, deliveredThrough);
}

/**
 * Detach AND forget which session this connection was on. Used by "+"
 * (ws-session-new.ts) and by a `conversation.activate` that lands on a
 * different session — both leave the connection anchored to nothing, which a
 * plain detach deliberately does not.
 */
export function unbindSession(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
  detachSession(ws, services);
  ws.data.conversationId = null;
}

/**
 * Tell a draft connection what it is holding: an EMPTY committed feed, then
 * the draft key.
 *
 * ONE ANSWER, TWO CALLERS — the handshake of a connection that presented
 * nothing, and the "+" that just unbound one. They must say the same thing,
 * because a client cannot tell the two apart and both leave it on a draft.
 *
 * The empty `conversation.snapshot` is not decoration. It is the same frame
 * every bound connection gets, and it is the ONLY thing that clears the
 * client's committed mirror: both SDKs replace their mirror wholesale on a
 * snapshot. Without it, "+" leaves the previous session's bubbles on screen
 * while the gateway has already stopped considering that session active — the
 * pane would show a conversation the next message does not continue.
 *
 * The `session.draft` frame carries the key the client re-presents on its next
 * `session.configure` and spends on its first message. It is also what lets a
 * client that gates its outbound queue on "a conversation is attached"
 * (mobile's `SendMessageUseCase.flushIfReady`) drain that queue at all — a
 * draft has no session id to hand it, and a permanently-null anchor is exactly
 * the `flush-skipped reason="no-id-attached"` hang.
 */
export function sendDraftHandshake(
  ws: ServerWebSocket<SessionData>,
  draftKey: string,
  requestId: string | undefined,
): void {
  sendConnectionFrame(ws, { type: "conversation.snapshot", items: [] });
  sendConnectionFrame(ws, {
    type: "session.draft",
    ...(requestId === undefined ? {} : { requestId }),
    draftKey,
    ts: Date.now(),
  });
}
