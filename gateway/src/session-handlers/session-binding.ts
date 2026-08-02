// Binding a connection to a session — the orchestrator handles, in one place.
//
// Extracted from `ws-session-configure.ts` because the bind no longer happens
// only at handshake time. A connection that presents no session id is a DRAFT
// (spec §4.2): no row, no id, no runtime. The id is minted when the first
// message arrives, and the runtime is built THEN — so the same construction
// has two callers (`handleSessionConfigure` on a re-opened session,
// `ws-handlers.ts` on the first message of a draft) and belongs in neither.
//
// This is also the seam plan task 5 replaces: `claim`/`release` on the
// single-owner `ConversationRuntimeRegistry` become `attach`/`detach` on a
// subscriber set, and `bindSessionRuntime` becomes the `build` callback the
// registry invokes on the FIRST attachment only. Keeping it as one function
// with one set of dependencies is what makes that a local change.

import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import { createTurnVoice } from "../runtime/turn-voice.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import { createSessionVoicePrefs } from "./session-voice-prefs.js";
import type { SessionData } from "./ws-helpers.js";
import { errorMessage } from "./ws-helpers.js";
import { sendGatewayFrame } from "./ws-send.js";
import { createWsTurnEmitter } from "./ws-turn-emitter.js";

const log = getLog(["sentient", "ws", "session-binding"]);

/** `ServerWebSocket.readyState` OPEN. The other three (CONNECTING, CLOSING,
 *  CLOSED) all mean this connection can no longer be served, and none of them
 *  can be the state of a socket that is mid-`session.configure`. */
const WS_READY_STATE_OPEN = 1;

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
 */
export function withSessionStore<T>(
  services: GatewayServices,
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
 * Build this connection's orchestrator handles for [sessionId] and park them
 * on the socket. Returns the live runtime, or null when none could be built.
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

  try {
    const emitter = createWsTurnEmitter(ws);
    // Voice composition (spec §6). Built HERE because this is the only place
    // that knows the socket, the emitter, the authenticated user's profile and
    // this connection's STT session — but DRIVEN inside SessionRuntime on the
    // turn's own AbortController, so barge-in and interrupt cancel TTS through
    // the same abort that stops the provider stream. See turn-voice.ts.
    // Parked on the socket too: `user.preferences.patch` applies a live mute
    // toggle through it (handle-preferences-patch.ts).
    const voicePrefs = createSessionVoicePrefs(services.profileStore, userId, connectionId);
    ws.data.voicePrefs = voicePrefs;
    const echoGuard = createMicEchoGuard(
      () => ws.data.stt,
      services.stt?.adapterConfig.ttsEchoCooldownMs ?? null,
      connectionId,
    );
    const synthesizer = services.createSynthesizerFor(() => voicePrefs.voiceId());
    const voice = synthesizer
      ? createTurnVoice({
          synthesizer,
          sink: emitter,
          echoGuard,
          shouldSpeak: () => voicePrefs.shouldSpeak(),
          sessionId: connectionId,
        })
      : null;
    // Both ids go in, named apart (`SessionRuntimeRequest`): the durable
    // session id becomes the store's partition key, while the connection-scoped
    // id reaches only the tool/permission brokers' log correlation.
    const handles = services.createSessionRuntime({
      principal,
      conversationId: sessionId,
      connectionId,
      emitter,
      voice,
    });
    ws.data.runtime = handles.runtime;
    ws.data.permissions = handles.permissions;
    // Take sole ownership of this session's live runtime. Claiming AFTER
    // construction, not before, so a factory throw leaves whatever socket
    // already holds the session running rather than killing it for a session
    // that never materialised.
    //
    // `isAlive` is read by the registry at QUERY time, so the ownership guards
    // in `ensureBoundRuntime` see this socket's CURRENT transport state rather
    // than a latch. This closure is the only place in the gateway that knows
    // which socket owns which claim, which is why the predicate is supplied
    // here rather than derived inside the registry.
    services.conversationRuntimes.claim(sessionId, connectionId, {
      isAlive: () => ws.readyState === WS_READY_STATE_OPEN,
      evict: () => disposeSessionHandles(ws),
    });
    log.info("session-binding.bound", { connectionId, userId, sessionId, hasVoice: voice !== null });
    return handles.runtime;
  } catch (err) {
    log.error("session-binding.runtime-construction-failed", {
      connectionId,
      userId,
      sessionId,
      reason: errorMessage(err, "unknown error"),
    });
    return null;
  }
}

/**
 * Tear down one connection's orchestrator handles and clear them off the
 * socket. Three callers, one body: a re-`session.configure` on this connection,
 * an explicit "+" that unbinds it, and the eviction hook a NEWER connection's
 * claim fires on this one. All must leave the socket in the same state — no
 * runtime, no permission broker — so `text.input` answers
 * `orchestrator_unavailable` (ws-handlers.ts) instead of feeding a disposed
 * runtime, and `cleanupSession` finds nothing to redo.
 *
 * Permissions settle BEFORE the runtime is disposed: each open prompt is a
 * promise the ReAct loop is awaiting inside `broker.dispatch`, and an
 * unsettled one parks that turn for the full permission timeout.
 */
export function disposeSessionHandles(ws: ServerWebSocket<SessionData>): void {
  ws.data.permissions?.denyAll();
  ws.data.permissions = null;
  ws.data.runtime?.dispose();
  ws.data.runtime = null;
  // Minted with the runtime, cleared with it: the next bind hydrates a fresh
  // one from the profile, and a stale handle here would apply a mute toggle to
  // a `TurnVoice` no turn can ever reach.
  ws.data.voicePrefs = null;
}

/**
 * Drop this connection's binding: dispose the handles and hand the session's
 * live-runtime claim back. Used by "+" (ws-session-new.ts) and by a
 * re-`session.configure` that lands on a different session.
 */
export function unbindSession(ws: ServerWebSocket<SessionData>, services: GatewayServices, sessionId: string): void {
  disposeSessionHandles(ws);
  const connectionId = ws.data.sessionId;
  if (connectionId !== null) services.conversationRuntimes.release(sessionId, connectionId);
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
  sendGatewayFrame(ws, { type: "conversation.snapshot", items: [] });
  sendGatewayFrame(ws, {
    type: "session.draft",
    ...(requestId === undefined ? {} : { requestId }),
    draftKey,
    ts: Date.now(),
  });
}
