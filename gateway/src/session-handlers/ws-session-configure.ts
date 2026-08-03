import type { ClientType, GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import {
  bindSessionRuntime,
  completeAttach,
  completeAttachWithSnapshot,
  detachSession,
  sendDraftHandshake,
  withSessionStore,
} from "./session-binding.js";
import { isDraftKey, mintDraftKey, resolveSession } from "./session-id.js";
import type { SessionData } from "./ws-helpers.js";
import { sendError } from "./ws-helpers.js";
import { handleResumeOrFresh } from "./ws-resume.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "session-configure"]);

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 48000;
const AUDIO_ENCODING = "pcm16";

// ---------------------------------------------------------------------------
// Session configure — post-purge minimal form.
//
// This file used to own the whole Hermes-cycle session pipeline: ACP wire
// acquisition, conversation mirroring, attention-gate cycle dispatch, TTS
// wiring, resume/replay handover, and sessions (search/switch/rename). That
// entire pipeline existed to serve "every cycle = one Hermes round-trip",
// which 2.0's native orchestrator discards — it was purged wholesale in this
// task, alongside the four gateway/src trees that only served that pipeline.
//
// What remains is exactly the brief for Task 1: accept the WS connection,
// confirm auth already succeeded (ws-auth-gate runs before this handler),
// and hold the socket — record the client's declared capabilities/type and
// ack with session.ready so the connection is usable.
//
// Plan 2 Task 10 adds the one piece of orchestrator wiring that belongs
// HERE rather than in the message router: minting this session's
// `SessionRuntime` once the principal is known, via `services.
// createSessionRuntime({ principal, conversationId, connectionId, emitter })`
// — see `SessionRuntimeRequest` (runtime/session-handles.ts) for why those
// two ids are named apart, and the last paragraph below for what each one
// keys. From this point on, `ws.data.runtime` is the seam
// `text.input`/`interrupt` (ws-handlers.ts) route through — see that file for
// the message-level wiring, and ws-turn-emitter.ts for the outbound frame
// mapping.
//
// Plan 3 Task 6 makes that factory return a PAIR — `SessionHandles`
// { runtime, permissions }. The permission broker is connection-scoped for
// the same reason the runtime is, and lands on `ws.data.permissions` so
// `permission.response` (ws-handlers.ts) can settle only prompts THIS socket
// issued.
//
// Plan 3 Task 2 adds the voice half: this handler also composes the session's
// `TurnVoice` (profile-backed voice id + audio prefs, mic echo guard, TTS
// synthesizer) and hands it to `createSessionRuntime`, so the ReAct loop's
// text deltas fork into TTS on the turn's own AbortController. The STT half
// is lazy — ws-handlers.ts mints `ws.data.stt` on the first `audio.start`.
//
// Plan 3 Task 10 adds the second piece: acquiring this surface's frame
// journal from `services.replayRegistry` and running the resume decision
// (ws-resume.ts) before session.ready goes out. The `resume` field the
// client folds into this frame is now honoured, not just logged. session.ready
// itself now leaves through `sendGatewayFrame`, so it is validated against
// `gatewayMessageSchema` like every other outbound frame instead of being
// hand-serialised.
//
// Every NON-recovered handshake ends with a `conversation.snapshot`
// (runtime/conversation-feed.ts, via `SessionRuntime`). Without it a client
// renders an empty chat on every reload, reconnect-with-recovered:false, and
// first connect — the `turn.*` family is a live stream the client discards,
// so the committed feed is the only thing that survives a turn.
//
// Finally, this handler decides WHICH SESSION this connection is looking at
// (`resolveConnectionSession` below). Two ids live in this file and they are
// not the same thing: `sessionId` is this WebSocket connection and dies with
// it; the session the store partitions on outlives every socket. The store
// used to be keyed on the former, so a reload / reconnect / restart landed in
// a brand-new empty partition — the snapshot above came back empty AND the
// model projection replayed nothing, which is the whole of "the assistant
// forgot everything on reload".
//
// Session-model redesign, task 3: that id is no longer DERIVED from the
// principal and the surface. It is ALLOCATED (session-id.ts) when the first
// message of a draft arrives, and a client-presented id is honoured only when
// the store this caller's capability opens already holds it. A connection that
// presents nothing — a fresh tab, a first launch, the window right after "+" —
// is a DRAFT: no row, no id, no runtime, nothing in the session list. Ten
// opened tabs leave no trace.
//
// Because that id is durable it is also SHARED, so the runtime it keys lives in
// `services.sessionRegistry` rather than on this socket: this connection
// ATTACHES to the session (task 5), building its runtime only if it is the
// first to arrive. A second window joins the same loop instead of forking a
// second one over the same append-only log — and, unlike the single-owner
// registry this replaced, without tearing the first window down.
// ---------------------------------------------------------------------------

export function handleSessionConfigure(
  ws: ServerWebSocket<SessionData>,
  capabilities: readonly string[],
  language: "en" | "zh",
  services: GatewayServices,
  clientType: ClientType,
  configureDeviceId: string,
  configureSurfaceId: string | undefined,
  configureResume: SessionConfigureResume | undefined,
  configureConversationId: string | undefined,
): void {
  const sessionId = ws.data.sessionId;
  if (!sessionId) {
    sendError(ws, "protocol_error", "No active session");
    return;
  }
  const principal = ws.data.principal;
  if (!principal) {
    log.warn("session-configure-no-user", { sessionId, reason: "auth gate must set ws.data.principal" });
    sendError(ws, "protocol_error", "Session not authenticated");
    return;
  }
  const userId = principal.userId;

  ws.data.grantedCapabilities = new Set(capabilities);
  ws.data.clientType = clientType;

  // `surfaceId` no longer partitions ANYTHING (session-model task 6). It was
  // the journal's key while a surface owned its own seq space; the journal is
  // the SESSION's now, acquired with the session's handles, so two browser tabs
  // of one user are two cursors into one stream rather than two streams. The
  // field is kept because it is on the frozen wire and it is what a log line
  // uses to tell those two tabs apart.
  const surfaceId = configureSurfaceId ?? configureDeviceId;

  // --- Session identity: membership lookup, or a draft ---
  //
  // Resolved before the runtime block, because it is a runtime construction
  // input. Deliberately NOT `sessionId`: that one is minted per WebSocket
  // connection, so partitioning the store on it opened a brand-new empty
  // partition on every reload, reconnect and restart — the committed feed came
  // back empty and the model projection handed the LLM no history at all
  // (spec §10 acceptance #9).
  const resolved = resolveConnectionSession(ws, services, configureConversationId);

  // A repeat session.configure on the same connection leaves the session it
  // was on — otherwise this connection would hold two attachments and its
  // close would release only one, pinning a session resident forever. Whether
  // the prior session's runtime is DISPOSED by that detach is the registry's
  // decision, not this handler's: sole attachment, so today it is; with
  // another window still attached, it is not.
  //
  // The session's frame journal is not torn down with it either: it belongs to
  // the SESSION and outlives its handles in the replay registry's retention
  // window, so a re-configure that lands back on the same session gets the same
  // journal and the same epoch, and the replay this handshake is about to
  // promise stays contiguous.
  if (ws.data.attachment !== null) {
    log.info("session-configure.reconfigure", {
      sessionId,
      userId,
      conversationId: ws.data.conversationId,
      reason: "detaching from the session this connection was already on",
    });
    detachSession(ws, services);
  }

  // `conversationId` is the session this connection has RESOLVED; `runtime` is
  // whether it is currently serviceable. They are set together on the happy
  // path and can diverge on exactly one: a bind failure (no active LLM key
  // resolved for this user). The id is kept anyway, and deliberately — it is
  // the only record of WHICH session the client asked for, and clearing it
  // would send their next message into a brand-new one instead. The recovery is
  // a late re-bind on the next message (`ensureBoundRuntime`, ws-handlers.ts),
  // which is what stops this state being permanent.
  //
  // Safe to hold without a runtime: a failed bind attaches nothing (the
  // registry either registers the attachment or propagates the build failure),
  // and `detachSession` is keyed on THIS connection's attachment id, so its
  // teardown cannot unseat a window that did attach.
  ws.data.conversationId = resolved.sessionId;
  ws.data.draftKey = resolved.draftKey;
  // The bind ATTACHES this connection to the session and takes its journal:
  // one seq space shared with every other window on it. It also HOLDS this
  // window — it receives nothing until the attach is completed below, which is
  // what makes "the snapshot, then the frames that arrived meanwhile" a single
  // linearization point rather than two steps with a hole between them.
  const hasRuntime = resolved.sessionId !== null && bindSessionRuntime(ws, services, resolved.sessionId) !== null;
  // A resume is honourable only when this connection's cursor is in the same
  // seq space the session's journal is still allocating from.
  const epochMatches = configureResume !== undefined && configureResume.epoch === ws.data.epoch;

  log.info("session-configured", {
    sessionId,
    userId,
    capabilities,
    clientType,
    language,
    deviceId: configureDeviceId,
    surfaceId,
    hasRuntime,
    epoch: ws.data.epoch,
    resumed: epochMatches,
    requestedResumeLastSeq: configureResume?.lastSeq ?? null,
    conversationId: resolved.sessionId,
    draft: resolved.sessionId === null,
  });

  const readyFrame: GatewayMessage = {
    type: "session.ready",
    sessionId,
    audioEncoding: AUDIO_ENCODING,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    enabledEffects: [],
    playback: {
      minEagerEndMs: services.webui.playback.min_eager_end_ms,
      preemptFadeoutMs: services.webui.playback.preempt_fadeout_ms,
    },
  };

  // On the recovered path this sends session.ready itself (RAW, before the
  // stream.resumed ack and the verbatim replay) and returns the seq it replayed
  // through — see ws-resume.ts for why that order is load-bearing. Every other
  // path returns null and we send the normal ready below.
  const replayedThrough = handleResumeOrFresh({
    ws,
    sessionId,
    journal: ws.data.journal,
    epoch: ws.data.epoch,
    epochMatches,
    resumeParams: configureResume,
    readyFrame,
  });
  if (replayedThrough !== null) {
    // Recovered: the client's mirror is intact and the replay just carried it
    // to `replayedThrough`, so it gets NO snapshot — only the frames that
    // arrived while it was held, which is everything past that seq.
    completeAttach(ws, services, replayedThrough);
    return;
  }

  sendConnectionFrame(ws, readyFrame);
  if (resolved.sessionId === null) {
    sendDraftHandshake(ws, resolved.draftKey, undefined);
    return;
  }
  sendConversationSnapshot(ws, services, sessionId, resolved.sessionId, userId);
}

/** What this connection is looking at: a real session, or a draft holding the
 *  key its first message will mint under. Exactly one of the two is set. */
interface ConnectionSession {
  sessionId: string | null;
  draftKey: string;
}

/**
 * Decide which session this connection opens — MEMBERSHIP, not derivation and
 * not a prefix parse (spec §3.5).
 *
 * Four inputs, four answers:
 *
 *  - **nothing presented** — a fresh tab or a first launch. A DRAFT: no row,
 *    no id, no runtime, nothing in the session list. The id is allocated when
 *    the first message arrives (ws-handlers.ts), so ten opened tabs leave the
 *    list unchanged.
 *  - **a draft key** — the client is mid-draft and reconnected. Stay on the
 *    same draft, so the first message still mints under the key the client
 *    already holds and a lost `session.created` ack cannot fork a second
 *    session out of the retry.
 *  - **a session id the caller's store holds** — open it. This covers both
 *    shapes identically: a minted id (a `sessions` row) and a legacy
 *    `c::<userId>::<surfaceId>` partition (entries, no row). The store was
 *    already chosen by the caller's capability, which is why membership is a
 *    STRONGER check than the prefix parse it replaces — and why the
 *    `surfaceId` inside a legacy id is dead metadata that nothing reads.
 *  - **anything else** — REFUSED, and the connection starts a fresh draft.
 *    The old behaviour created an empty partition for any well-formed string,
 *    which let a client spam a user's database with rows nothing can list,
 *    open or delete.
 */
function resolveConnectionSession(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  presented: string | undefined,
): ConnectionSession {
  const connectionId = ws.data.sessionId;
  const principal = ws.data.principal;
  if (principal === null) return { sessionId: null, draftKey: mintDraftKey() };
  const userId = principal.userId;

  if (presented === undefined) {
    const draftKey = mintDraftKey();
    log.info("session-configure.draft.fresh", { sessionId: connectionId, userId, draftKey });
    return { sessionId: null, draftKey };
  }

  if (isDraftKey(presented)) {
    log.info("session-configure.draft.resumed", { sessionId: connectionId, userId, draftKey: presented });
    return { sessionId: null, draftKey: presented };
  }

  const resolution = withSessionStore(services, principal, (store) => resolveSession({ store, presented }));
  if ("sessionId" in resolution) {
    log.info("session-configure.session.opened", {
      sessionId: connectionId,
      userId,
      conversationId: resolution.sessionId,
    });
    return { sessionId: resolution.sessionId, draftKey: mintDraftKey() };
  }

  const draftKey = mintDraftKey();
  log.warn("session-configure.session.refused", {
    sessionId: connectionId,
    userId,
    draftKey,
    reason: `presented session id was ${resolution.rejected} in this caller's store — starting a draft instead of creating it`,
  });
  return { sessionId: null, draftKey };
}

/**
 * Hand the client its committed conversation feed, right after session.ready.
 *
 * ONLY on the non-recovered paths (fresh connect, and a resume the journal
 * could not honour). A recovered resume replays the exact frames the client
 * missed, and its mirror is still intact — a snapshot there would fight that
 * replay. `replayedThrough` is precisely the recovered flag, so this reads off
 * the same decision rather than re-deriving it.
 *
 * It also completes the ATTACH: the connection has been held since it bound, so
 * the snapshot and the drain of everything emitted meanwhile are one
 * linearization point (fan-out-emitter.ts's `attachWithSnapshot`).
 *
 * The feed lives on the SessionRuntime because the runtime owns the store
 * handle. No runtime (orchestrator absent, or per-session construction
 * failure) means no store to project — the socket is still usable, so this
 * logs its reason rather than failing the handshake.
 *
 * DOES THIS CLOSE `recovered:false` WITHOUT THE MISSING REST ROUTE? Per client:
 *
 *  - **web: yes, but only because of the frame order** — and that order is now
 *    pinned by ws-session-configure.test.ts. Both client SDKs treat
 *    `stream.resumed{recovered:false}` as "refetch history over
 *    `GET /sessions/:id/messages`", a route this gateway does not serve
 *    (sessions CRUD is later scope), and both replace their mirror with an
 *    EMPTY list when that fetch fails. web-sdk attaches its
 *    ConversationHistoryConnector only on `session.ready`
 *    (sdk-message-router.ts's `handleReady` → `attachAll`), and ws-resume.ts
 *    sends the ack BEFORE ready, so the synthetic `session.switched` reaches no
 *    history connector and no fetch is made — this snapshot is then the only
 *    thing that fills the mirror. Reordering either side reawakens the 404 and
 *    wipes the chat a moment after this frame filled it.
 *  - **mobile: no — a live residual.** `SentientSdk.onStreamResumed` calls
 *    `refetchHistoryForSession` directly, with no handler-map gate to be
 *    detached, so the 404 lands AFTER this snapshot and clears the mirror
 *    (SdkConnectors.loadHistoryForSession's error branch → `replaceMirror(
 *    emptyList())`). Closing it needs the REST route or a mobile-sdk change;
 *    neither is in this task's scope, and no gateway-side ordering can beat an
 *    async client fetch.
 */
function sendConversationSnapshot(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  sessionId: string,
  conversationId: string,
  userId: string,
): void {
  if (completeAttachWithSnapshot(ws, services)) return;
  log.warn("session-configure.no-conversation-snapshot", {
    sessionId,
    conversationId,
    userId,
    reason: "this connection is not attached to a session runtime — no store to project",
  });
}
