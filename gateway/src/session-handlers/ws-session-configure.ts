import type { ClientType, GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { createTurnVoice } from "../runtime/turn-voice.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import type { ReplayAcquisition } from "./replay-registry.js";
import { createSessionVoicePrefs } from "./session-voice-prefs.js";
import type { SessionData } from "./ws-helpers.js";
import { errorMessage, sendError } from "./ws-helpers.js";
import { handleResumeOrFresh } from "./ws-resume.js";
import { sendGatewayFrame } from "./ws-send.js";
import { createWsTurnEmitter } from "./ws-turn-emitter.js";

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
// createSessionRuntime(principal, sessionId, WsTurnEmitter(ws))`. From this
// point on, `ws.data.runtime` is the seam `text.input`/`interrupt`
// (ws-handlers.ts) route through — see that file for the message-level
// wiring, and ws-turn-emitter.ts for the outbound frame mapping.
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
// Finally, every NON-recovered handshake ends with a `conversation.snapshot`
// (runtime/conversation-feed.ts, via `SessionRuntime`). Without it a client
// renders an empty chat on every reload, reconnect-with-recovered:false, and
// first connect — the `turn.*` family is a live stream the client discards,
// so the committed feed is the only thing that survives a turn.
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

  // --- Reconnect gap-fill: acquire this surface's frame journal ---
  //
  // Keyed `${userId}::${surfaceId}`, matching SessionRuntime's own identity.
  // surfaceId falls back to deviceId when the client omits it — mandated by
  // sessionConfigureSchema.surfaceId's contract note, and the reason two
  // browser tabs of one user stay independent. The registry (not this
  // connection) OWNS the journal: a resumed surface gets the same object
  // back and its seq counter simply continues, which is what makes replay
  // contiguous across the socket boundary.
  //
  // Acquired BEFORE the runtime block, so any frame the runtime can emit is
  // already sequenced. `acquireSurfaceJournal` (bottom of this file) owns the
  // one case the registry cannot see from the outside: a re-configure on a
  // connection that already holds THIS surface keeps its journal instead of
  // minting a fresh one.
  const surfaceId = configureSurfaceId ?? configureDeviceId;
  const replayKey = `${userId}::${surfaceId}`;
  const acquisition = acquireSurfaceJournal(ws, services, replayKey, sessionId, configureResume?.epoch);
  ws.data.journal = acquisition.journal;
  ws.data.epoch = acquisition.epoch;
  ws.data.replayLease = acquisition.lease;

  // A repeat session.configure on the same connection must not leak the
  // previous runtime's store handle or strand its open permission prompts —
  // tear both down before minting a fresh pair. The frame journal above is
  // deliberately NOT torn down with them: it belongs to the surface, not to
  // the runtime, and losing it here would break the very replay this
  // handshake just promised.
  if (ws.data.runtime) {
    log.info("session-configure.reconfigure", { sessionId, userId, reason: "disposing prior runtime" });
    ws.data.permissions?.denyAll();
    ws.data.permissions = null;
    ws.data.runtime.dispose();
    ws.data.runtime = null;
  }

  let hasVoice = false;

  if (services.createSessionRuntime) {
    try {
      const emitter = createWsTurnEmitter(ws);
      // Voice composition (spec §6). Built HERE because this is the only
      // place that knows the socket, the emitter, the authenticated user's
      // profile, and this connection's STT session — but DRIVEN inside
      // SessionRuntime on the turn's own AbortController, so barge-in and
      // interrupt cancel TTS through the same abort that stops the provider
      // stream. See runtime/turn-voice.ts's header.
      const voicePrefs = createSessionVoicePrefs(services.profileStore, userId, sessionId);
      const echoGuard = createMicEchoGuard(
        () => ws.data.stt,
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
      hasVoice = voice !== null;
      const handles = services.createSessionRuntime(principal, sessionId, emitter, voice);
      ws.data.runtime = handles.runtime;
      ws.data.permissions = handles.permissions;
    } catch (err) {
      // Thrown only when the orchestrator IS configured but no active LLM
      // key resolved from the secrets store (see phase-services.ts's
      // `buildCreateSessionRuntime`) — a genuine per-session misconfig, not
      // a reason to fail the whole handshake. Single-signal by design: this
      // handler does NOT sendError here (a session.configure that both
      // errors AND acks with session.ready is contradictory) — the socket
      // is otherwise perfectly usable for everything that doesn't need the
      // orchestrator, so session.ready still follows below with
      // `ws.data.runtime` left null, and `text.input` (ws-handlers.ts)
      // surfaces this exact "orchestrator_unavailable" error itself, at the
      // point the client actually tries to use it.
      log.error("session-configure.runtime-construction-failed", {
        sessionId,
        userId,
        reason: errorMessage(err, "unknown error"),
      });
    }
  } else {
    log.info("session-configure.no-orchestrator", { sessionId, userId, reason: "orchestrator: absent from config" });
  }

  log.info("session-configured", {
    sessionId,
    userId,
    capabilities,
    clientType,
    language,
    deviceId: configureDeviceId,
    surfaceId,
    hasRuntime: ws.data.runtime !== null,
    hasVoice,
    epoch: acquisition.epoch,
    resumed: acquisition.resumed,
    requestedResumeLastSeq: configureResume?.lastSeq ?? null,
    conversationId: configureConversationId ?? null,
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
  // stream.resumed ack and the verbatim replay) and returns true — see
  // ws-resume.ts for why that order is load-bearing. Every other path
  // returns false and we send the normal seq-stamped ready below.
  const readyAlreadySent = handleResumeOrFresh({
    ws,
    sessionId,
    surfaceKey: replayKey,
    journal: acquisition.journal,
    epoch: acquisition.epoch,
    resumed: acquisition.resumed,
    resumeParams: configureResume,
    readyFrame,
  });
  if (readyAlreadySent) return;

  sendGatewayFrame(ws, readyFrame);
  sendConversationSnapshot(ws, sessionId, userId);
}

/**
 * Hand the client its committed conversation feed, right after session.ready.
 *
 * ONLY on the non-recovered paths (fresh connect, and a resume the registry
 * could not honour). A recovered resume replays the exact frames the client
 * missed, and its mirror is still intact — a snapshot there would fight that
 * replay. `readyAlreadySent` is precisely the recovered flag, so this reads
 * off the same decision rather than re-deriving it.
 *
 * The feed lives on the SessionRuntime because the runtime owns the store
 * handle. No runtime (orchestrator absent, or per-session construction
 * failure) means no store to project — the socket is still usable, so this
 * logs its reason rather than failing the handshake.
 */
function sendConversationSnapshot(ws: ServerWebSocket<SessionData>, sessionId: string, userId: string): void {
  const runtime = ws.data.runtime;
  if (runtime === null) {
    log.warn("session-configure.no-conversation-snapshot", {
      sessionId,
      userId,
      reason: "no session runtime on this connection — no store to project",
    });
    return;
  }
  runtime.emitConversationSnapshot();
}

/**
 * Take — or KEEP — ownership of this surface's outbound frame journal.
 *
 * Three shapes:
 *
 *  1. **Re-configure of a surface this still-open connection already holds**
 *     (and no resume naming a foreign epoch). Nothing was lost: the socket
 *     never closed and this connection's own journal is still live and
 *     attached. So the lease, journal and epoch are kept VERBATIM. Releasing
 *     and re-acquiring here would present the registry with a detached entry
 *     and no resume request, which is its `no-resume-requested` mint-fresh
 *     branch — a live replay window silently discarded and an epoch jump the
 *     client can only read as a stream restart (`recovered:false` + a full
 *     REST refetch on its next reconnect).
 *  2. **Re-configure onto a different surface**, or a resume naming an epoch
 *     this connection is not on — a genuine handover. Park what this
 *     connection held FIRST, so the acquire sees a detached entry rather than
 *     reading this connection's own attachment as a rival live socket and
 *     minting a fresh journal underneath it.
 *  3. **First configure** — nothing held; straight to the registry.
 */
function acquireSurfaceJournal(
  ws: ServerWebSocket<SessionData>,
  services: GatewayServices,
  surfaceKey: string,
  sessionId: string,
  resumeEpoch: number | undefined,
): ReplayAcquisition {
  const heldLease = ws.data.replayLease;
  if (heldLease === null) return services.replayRegistry.acquire(surfaceKey, resumeEpoch);

  const heldJournal = ws.data.journal;
  const isSameSurface = heldLease.surfaceKey === surfaceKey;
  const isEpochCompatible = resumeEpoch === undefined || resumeEpoch === ws.data.epoch;
  if (heldJournal !== null && isSameSurface && isEpochCompatible) {
    log.info("session-configure.journal-retained", {
      sessionId,
      surfaceKey,
      epoch: ws.data.epoch,
      leaseId: heldLease.id,
      newestSeq: heldJournal.newestSeq,
      reason: "re-configure on a still-open connection for the same surface — nothing was lost",
    });
    return { journal: heldJournal, epoch: ws.data.epoch, resumed: true, lease: heldLease };
  }

  services.replayRegistry.release(heldLease);
  return services.replayRegistry.acquire(surfaceKey, resumeEpoch);
}
