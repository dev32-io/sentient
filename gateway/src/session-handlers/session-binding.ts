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
import { SESSION_CLOSED_MESSAGE } from "../runtime/permission-prompt.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { createTurnVoice } from "../runtime/turn-voice.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { type CommittedFeedSource, attachWithSnapshot, createFanOutTurnEmitter } from "./fan-out-emitter.js";
import { createInputArbiter } from "./input-arbiter.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import type { ReplayAcquisition } from "./replay-registry.js";
import type { Attachment, SessionHandles } from "./session-registry.js";
import { refuseStaleAuthority } from "./stale-authority.js";
import { createUserAudioPolicy } from "./user-audio-policy.js";
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
  services: Pick<GatewayServices, "accessManager" | "dbFileName">,
  principal: UserPrincipal,
  use: (store: SessionStore) => T,
): T {
  const store = openSessionStore(services.accessManager.grant(principal, "session-store"), services.dbFileName);
  try {
    return use(store);
  } finally {
    store.close();
  }
}

/**
 * What a bind attempt did. THREE outcomes, not two, because "no runtime" and
 * "this socket may not have one" are opposite instructions to the caller: the
 * first leaves a usable connection that simply cannot run a turn, the second
 * means the socket is already CLOSED and everything after it is writing into a
 * corpse.
 */
export type BindOutcome =
  | { readonly kind: "bound"; readonly runtime: SessionRuntime }
  /** No runtime could be constructed, and the socket is FINE — the orchestrator
   *  is absent from config, or this user's per-session construction failed. */
  | { readonly kind: "no-runtime" }
  /** This connection's authority no longer matches the record. The socket has
   *  been told `auth.error` and closed; the caller must STOP, not degrade. */
  | { readonly kind: "refused" };

/**
 * Attach this connection to [sessionId] and park the session's handles on the
 * socket.
 *
 * COMPLETE MEDIATION AT THE MINT (plan 2026-08-07-tool-permissions task 2c,
 * review round 2). This is the ONE path on which `ws.data.principal` becomes
 * AUTHORITY: `buildSessionHandles` hands it to `services.createSessionRuntime`,
 * which mints the session's `tool-broker` capability with that principal's role
 * baked in by value (`phase-services.ts`). So the authority re-check belongs
 * here and nowhere else.
 *
 * A GATE PER ARM WOULD NOT HOLD. `session.configure`, `conversation.activate`
 * and the late re-bind in `ws-handlers.ts` all reach this function, and
 * `conversation.activate` needs no prior handshake at all — it guards on the
 * principal alone, so a socket that authenticated and never configured reaches
 * the mint through it. Checking in each arm means the next arm that touches
 * `ws.data.principal` silently reopens the hole. Checked HERE, every arm is
 * covered by construction and a new one cannot skip what it does not call.
 *
 * WHY THE ROLE IS THE ONLY THING THAT CAN GO STALE: a principal is
 * `{userId, role, householdId}`, and identity is immutable — a userId cannot
 * change under a live socket. `session-store` capabilities are confined by
 * userId, so a stale one grants exactly what it always did. `tool-broker` is
 * the capability whose behaviour reads the role (`canExecute`'s impact tier),
 * and it is minted below.
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
 *
 * ASYNC ONLY FOR THAT RE-CHECK, and the await is at the TOP — before the
 * attachment check and before any field on `ws.data` is written. Everything
 * from there to the `session.attached` frame stays one synchronous block, so a
 * second bind interleaving on this connection still sees a complete attachment
 * and takes the detach-first path rather than stranding one.
 */
export async function bindSessionRuntime(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  sessionId: string,
): Promise<BindOutcome> {
  const connectionId = ws.data.sessionId;
  const principal = ws.data.principal;
  if (connectionId === null || principal === null) {
    log.warn("session-binding.no-principal", {
      sessionId,
      reason: "bind attempted on a connection that has not authenticated",
    });
    return { kind: "no-runtime" };
  }
  const userId = principal.userId;

  const stale = await refuseStaleAuthority(ws, services.auth.users);
  if (stale !== null) {
    log.warn("session-binding.authority-refused", {
      connectionId,
      userId,
      sessionId,
      reason: stale,
      detail: "the record no longer grants this socket's authority — no capability was minted",
    });
    return { kind: "refused" };
  }

  if (!services.createSessionRuntime) {
    log.info("session-binding.no-orchestrator", { connectionId, userId, reason: "orchestrator: absent from config" });
    return { kind: "no-runtime" };
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
    return { kind: "no-runtime" };
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
    return { kind: "no-runtime" };
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
  // TELL THE CLIENT WHICH WINDOW IT IS (spec §3.7). This is the only source of
  // the `{sessionId, generation}` pair a client stamps on its commands, and it
  // goes out from the ONE place an attachment is minted, so there is no path
  // that attaches without announcing it.
  //
  // Ahead of the handshake frames on purpose: `session.ready` /
  // `session.created` / `session.switched` all follow this call, and a client
  // that learned its session id before its binding could stamp a command with a
  // generation it does not yet have. It bypasses the fan-out HOLD legitimately —
  // it is connection-lane, so it is neither sequenced nor journaled, and it
  // describes this socket rather than the conversation.
  sendConnectionFrame(ws, {
    type: "session.attached",
    sessionId,
    generation: attachment.generation,
  });
  return { kind: "bound", runtime: handles.runtime };
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
  //
  // EVERYTHING BELOW IS INSIDE A RELEASE GUARD, and that is not defensive
  // habit — `createSessionRuntime` genuinely throws when no active LLM key
  // resolves for this user (phase-services.ts), which is a per-session
  // misconfiguration `bindSessionRuntime` catches and recovers from. The ONLY
  // other release is `dispose()` below, on handles this function never
  // returned, so without the guard that throw pins the journal: `acquire`
  // added a lease and cleared `detachedAtMs`, and the registry starts a
  // retention clock only when the lease set EMPTIES — so the entry is never
  // swept and its bytes are held for the life of the process, once per
  // affected session. The shape this replaced parked the lease on the socket
  // and released it in `cleanupSession`, which survived exactly this failure.
  const acquisition = services.replayRegistry.acquire(sessionId);
  try {
    return buildHandlesOver(services, principal, sessionId, connectionId, acquisition);
  } catch (err) {
    services.replayRegistry.release(acquisition.lease);
    log.warn("session-binding.journal-released-on-build-failure", {
      connectionId,
      sessionId,
      leaseId: acquisition.lease.id,
      reason: "session handles could not be constructed — releasing the journal instead of pinning it",
    });
    throw err;
  }
}

/** The construction itself. Split out so the caller's `try` covers ALL of it —
 *  an inline try/catch around a 60-line body invites a future edit to land
 *  above it. */
function buildHandlesOver(
  services: GatewayServices,
  principal: UserPrincipal,
  sessionId: string,
  connectionId: string,
  acquisition: ReplayAcquisition,
): SessionHandles {
  const fanOut = createFanOutTurnEmitter({
    registry: services.sessionRegistry,
    sessionId,
    journal: acquisition.journal,
    epoch: acquisition.epoch,
    maxLagBytes: services.session.max_window_lag_bytes,
  });
  const emitter = fanOut;
  // The session's input floor (spec §8.3). Built here rather than in the
  // mediator because it is SESSION state: contention is between the windows of
  // one session, and it must be released when the session is. A map keyed by
  // session id inside the mediator would outlive every session it ever saw.
  const arbiter = createInputArbiter(sessionId, services.session.input_arbitration_window_ms);
  // Voice composition (spec §6). Built HERE because this is the only place
  // that knows the emitter, the authenticated user's profile and the session's
  // STT session — but DRIVEN inside SessionRuntime on the turn's own
  // AbortController, so barge-in and interrupt cancel TTS through the same
  // abort that stops the provider stream. See turn-voice.ts.
  //
  // The policy is a READER, not a copy: it is not parked on the socket or the
  // session handles, because nothing else needs to reach it. A preference
  // patch persists to the profile and the next read sees it — there is no
  // second copy to keep in step. See user-audio-policy.ts.
  const audioPolicy = createUserAudioPolicy(services.profileStore, principal.userId, connectionId);
  // Every attached window's mic, read at TTS-start time — the session's TTS
  // reaches all of them, so a guard scoped to this one connection would leave
  // the others open on the assistant's own voice (self-triggered barge-in).
  const echoGuard = createMicEchoGuard(
    () => fanOut.sockets.flatMap((window) => (window.data.stt === null ? [] : [window.data.stt])),
    services.stt?.adapterConfig.ttsEchoCooldownMs ?? null,
    sessionId,
  );
  const synthesizer = services.createSynthesizerFor(() => audioPolicy.voiceId());
  const voice = synthesizer
    ? createTurnVoice({
        synthesizer,
        sink: emitter,
        echoGuard,
        shouldSpeak: () => audioPolicy.shouldSpeak(),
        // Task 8's gate, and the reason it is separate from `shouldSpeak`:
        // a session now outlives its last window by `retention_ms` and keeps
        // running turns while a background task completes. A drain already in
        // flight when the last window leaves is the other half of the same
        // problem, cut by `cutUnheardSpeech()` below.
        hasAudience: () => fanOut.size > 0,
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
    // The delivery set itself, read at prompt time — the same source the
    // fan-out writes through, so "somebody can see this dialog" and "somebody
    // is being written to" can never disagree.
    attachedWindows: () => fanOut.size,
    // The same authority `TurnVoice` asks at drain time, so the `<situation>`
    // block's `delivery:` line cannot claim one thing while the audio path
    // does another.
    audioPolicy,
    voice,
    // Work COMPLETING is not an attach or a detach, so the registry would
    // otherwise never learn that the last thing holding this session resident
    // has finished (task 8). Keyed on `sessionId` and resolved through the
    // registry at call time, never captured: by the time this fires the session
    // may already be gone, and `reevaluate` on an unknown id is a no-op.
    onWorkSettled: () => services.sessionRegistry.reevaluate(sessionId),
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
    // Getters over the runtime, the tool broker and the permission broker —
    // what makes this session's residency a DERIVED property rather than a
    // consequence of which window happened to close last.
    work: built.work,
    arbiter,
    fanOut,
    journal: acquisition.journal,
    epoch: acquisition.epoch,
    replayLease: acquisition.lease,
    // Permissions settle BEFORE the runtime is disposed: each open prompt is a
    // promise the ReAct loop is awaiting inside `broker.dispatch`, and an
    // unsettled one parks that turn for the full permission timeout. The
    // reason is MODEL-FACING copy — it becomes the tool result that parked
    // dispatch sees.
    dispose() {
      built.permissions.denyAll(SESSION_CLOSED_MESSAGE);
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
 * connection; whether losing this attachment ends the session is the registry's
 * disposal policy's decision — since task 8, the retention predicate
 * (runtime/session-retention.ts), which keeps the session while any work is
 * outstanding. That separation is the whole cutover — a connection disposing
 * the runtime it happens to hold IS the eviction task 5 deleted.
 *
 * It DOES silence the session, when it is the last window out: see
 * `cutUnheardSpeech` below.
 *
 * Four callers, one body: a re-`session.configure`, an explicit "+", a
 * `conversation.activate` onto a different session, and `cleanupSession`. All
 * must leave the socket in the same state — no attachment, no runtime — so
 * `text.input` answers `orchestrator_unavailable` (ws-handlers.ts) instead of
 * feeding a session it has left. Dropping the ATTACHMENT is also what stops
 * this socket answering the session's permission prompts: since task 7 that
 * routing goes through the registry, and a connection with no attachment has
 * no window to answer from.
 *
 * ONE FIELD, NOT TWO (task 9). The session id comes off the ATTACHMENT, the
 * same place `permission.response` and the command mediator read it. It used to
 * come off `ws.data.conversationId`, which paired the attachment being removed
 * with a session id from a DIFFERENT field — correct only while an ordering
 * invariant held across every bind, detach and switch. That was never a
 * security boundary here (the lookup is by session then by `attachmentId`, and
 * those are 16-byte CSPRNG per attach, so a diverged id could only make the
 * removal a no-op) — but a no-op detach LEAKS: the window stays in the
 * subscriber set, keeps receiving a conversation it has left, and holds that
 * session resident for the life of the process. This is the task that makes
 * connections switch sessions, so it is the task that stops pairing two fields.
 *
 * Takes only the slice of `GatewayServices` it reads, so the command mediator —
 * which holds a `SessionRegistry` and nothing else — can detach an expired
 * credential through this one body instead of open-coding a second teardown.
 */
export function detachSession(
  ws: ServerWebSocket<SessionData>,
  services: Pick<GatewayServices, "sessionRegistry">,
): void {
  const attachment = ws.data.attachment;
  if (attachment !== null) {
    const sessionId = attachment.sessionId;
    // ONE removal, not two: the socket lives IN the subscriber set now, so
    // dropping the attachment drops the delivery target with it. Task 5 had to
    // keep a parallel window map in step by hand here.
    services.sessionRegistry.detach(sessionId, attachment.attachmentId);
    const remaining = services.sessionRegistry.subscribers(sessionId).length;
    log.info("session-binding.detached", {
      connectionId: ws.data.sessionId,
      sessionId,
      attachmentId: attachment.attachmentId,
      subscribers: remaining,
    });
    // AFTER the detach, so `subscribers` is the count that matters, and only
    // when the session SURVIVED it (a disposal already cut the drain itself).
    // Speech outlives its turn, so a tail can still be pulling from local-tts
    // with nobody left to hear it — see `SessionRuntime.cutUnheardSpeech`.
    if (remaining === 0) services.sessionRegistry.handlesFor(sessionId)?.runtime.cutUnheardSpeech();
  }
  // DROP THE MIC UPLINK'S IN-FLIGHT UTTERANCE, and this line is what makes
  // "binary audio binds to the CONNECTION rather than to a stamped header"
  // (command-mediator.ts) a sound decision instead of a claim.
  //
  // Mic bytes carry no `{sessionId, generation}`. They are captured under the
  // attachment this connection held WHEN THE PERSON SPOKE, and they become a
  // command only later, at the transcript. Without this, an utterance begun in
  // chat A survives a drawer switch and finalizes into chat B: the STT socket
  // is untouched, `micOpen` is still true, and the next `audio.end` — carrying
  // the NEW binding, so perfectly valid — force-flushes words spoken into a
  // conversation the person has left. Semantic turn-end reaches the same place
  // with no client frame at all, and a mic onset would barge into B's turn for
  // every window on it.
  //
  // IT HAS TO BE HERE RATHER THAN ON A REFUSAL PATH. A drawer switch sends
  // `conversation.activate`, which is deliberately UNSTAMPED — it is how a
  // connection LEAVES — so nothing is ever refused and the mediator never sees
  // it. Every leave funnels through this function.
  //
  // `discard()`, never `end()`: leaving a session abandons the identified
  // capture without flushing. The client must establish a fresh capture after
  // the switch; old producer callbacks remain harmless because this WS gate is
  // cleared before the STT uplink is discarded.
  ws.data.audioCapture = null;
  ws.data.stt?.discard();
  ws.data.attachment = null;
  ws.data.runtime = null;
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
 * [committedFeed] chooses where the joiner's COMMITTED history comes from —
 * this directed snapshot, or the client's own REST refetch. It does NOT gate
 * the turn-state reconstruction: a window that lands mid-turn needs the
 * transient prerequisites either way, and no REST route carries them.
 *
 * Returns false when this connection is not attached, so the caller can log its
 * own reason rather than guess at one.
 */
export function completeAttachWithSnapshot(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  committedFeed: CommittedFeedSource = "snapshot",
): boolean {
  const sessionId = ws.data.conversationId;
  if (ws.data.runtime === null || ws.data.attachment === null || sessionId === null) return false;
  if (services.sessionRegistry.handlesFor(sessionId) === null) return false;
  attachWithSnapshot(services.sessionRegistry, sessionId, ws, committedFeed);
  return true;
}

/**
 * Finish an attach with a plain drain — no committed feed, no turn-state
 * reconstruction.
 *
 * Two callers, and neither can be mid-turn from this window's point of view: a
 * FRESH mint (the session was created by this very message, so there is no
 * prior turn and the user's own entry follows immediately) and a RECOVERED
 * resume (the client's cursor genuinely reached `deliveredThrough`, so it
 * already saw whatever prerequisites the turn emitted).
 *
 * `conversation.activate` deliberately does NOT come here: it takes no
 * committed snapshot — the client refetches — but it can land mid-turn, so it
 * needs the reconstruction (`completeAttachWithSnapshot(…, "client-refetch")`).
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
