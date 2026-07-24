import type { ClientType, SessionConfigureResume } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";
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
  // reconnect/resume flow) must not leak the previous runtime's store
  // handle — dispose it before minting a fresh one.
  if (ws.data.runtime) {
    log.info("session-configure.reconfigure", { sessionId, userId, reason: "disposing prior runtime" });
    ws.data.runtime.dispose();
    ws.data.runtime = null;
  }

  if (services.createSessionRuntime) {
    try {
      const emitter = createWsTurnEmitter(ws);
      ws.data.runtime = services.createSessionRuntime(principal, sessionId, emitter);
    } catch (err) {
      // Thrown only when the orchestrator IS configured but no active LLM
      // key resolved from the secrets store (see phase-services.ts's
      // `buildCreateSessionRuntime`) — a genuine per-session misconfig, not
      // a reason to fail the whole handshake. session.ready still follows
      // below; text.input will find ws.data.runtime null and no-op.
      log.error("session-configure.runtime-construction-failed", {
        sessionId,
        userId,
        reason: errorMessage(err, "unknown error"),
      });
      sendError(ws, "orchestrator_unavailable", "Native orchestrator is not available (no active LLM key configured)");
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
