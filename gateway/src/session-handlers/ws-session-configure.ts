import type { ClientType, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
import { createTurnVoice } from "../runtime/turn-voice.js";
import { createMicEchoGuard } from "./mic-echo-guard.js";
import { createSessionVoicePrefs } from "./session-voice-prefs.js";
import type { SessionData } from "./ws-helpers.js";
import { errorMessage, sendError } from "./ws-helpers.js";
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

  // A repeat session.configure on the same connection (e.g. a future
  // reconnect/resume flow) must not leak the previous runtime's store handle
  // or strand its open permission prompts — tear both down before minting a
  // fresh pair.
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
    surfaceId: configureSurfaceId,
    hasRuntime: ws.data.runtime !== null,
    hasVoice,
    // Accepted but not acted on post-purge — resume/conversation-anchor
    // wiring goes with the rest of Plan 2's orchestrator rebuild.
    hasResume: configureResume !== undefined,
    conversationId: configureConversationId ?? null,
  });

  ws.send(
    JSON.stringify({
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
    }),
  );
}
