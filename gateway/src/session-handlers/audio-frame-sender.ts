import { getLog } from "../logging/logger.js";
import type { MicEchoGuard } from "./mic-echo-guard.js";

const log = getLog(["sentient", "session-handlers", "audio-frame-sender"]);

// ---------------------------------------------------------------------------
// drainAudioToWs — TTS audio frame stream → client WebSocket.
//
// Consumes the synthesizer's frame stream and sends:
//   1. One `connector.audio.start` (on first frame, with encoding metadata)
//   2. Binary frames as fast as they arrive
//   3. One `connector.audio.done` (on natural end)
//
// Threads through the MicEchoGuard so the mic is hard-muted for a cooldown
// window at TTS start (AEC convergence). Honors the abort signal —
// barge-in / interrupt cuts the loop without sending an audio.done (the
// consumer treats abort as cancel).
// ---------------------------------------------------------------------------

interface AudioFrameLike {
  data: Uint8Array;
  encoding: string;
  sampleRate: number;
}

export async function drainAudioToWs(
  frames: AsyncIterable<AudioFrameLike>,
  cycleId: string,
  sessionId: string,
  wsSend: (msg: unknown) => void,
  wsSendBinary: (data: Uint8Array) => void,
  signal: AbortSignal,
  echoGuard: MicEchoGuard,
): Promise<void> {
  const startedAtMs = Date.now();
  log.debug("drainAudioToWs.begin", { sessionId, cycleId });
  let startEmitted = false;
  let firstFrameAtMs = 0;
  let frameCount = 0;
  let bytesSent = 0;
  try {
    for await (const frame of frames) {
      if (signal.aborted) return;
      if (!startEmitted) {
        firstFrameAtMs = Date.now();
        log.info("wire.audio.start", {
          sessionId,
          cycleId,
          encoding: frame.encoding,
          sampleRate: frame.sampleRate,
          firstFrameMs: firstFrameAtMs - startedAtMs,
        });
        echoGuard.onTtsStart(cycleId);
        wsSend({
          type: "connector.audio.start",
          connector: "AssistantAudioResponseConnector",
          cycleId,
          taskId: cycleId,
          encoding: frame.encoding,
          sampleRate: frame.sampleRate,
        });
        startEmitted = true;
      }
      wsSendBinary(frame.data);
      frameCount++;
      bytesSent += frame.data.byteLength;
      log.debug("wire.audio.frame", {
        cycleId,
        frameIndex: frameCount,
        byteSize: frame.data.byteLength,
        bytesSent,
      });
    }
    if (startEmitted && !signal.aborted) {
      const elapsedSinceFirstFrameMs = Date.now() - firstFrameAtMs;
      log.info("wire.audio.done", {
        sessionId,
        cycleId,
        frameCount,
        bytesSent,
        elapsedMs: Date.now() - startedAtMs,
        elapsedSinceFirstFrameMs,
      });
      echoGuard.onTtsDone(cycleId);
      wsSend({
        type: "connector.audio.done",
        connector: "AssistantAudioResponseConnector",
        cycleId,
        taskId: cycleId,
      });
    }
  } catch (err: unknown) {
    log.warn("drainAudioToWs.error", {
      sessionId,
      cycleId,
      frameCount,
      bytesSent,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // Any aborted path — barge-in, interrupt, error — reset the mic gate
    // immediately so the user's speech reaches STT without waiting for the
    // tail timer from a prior onTtsDone call.
    if (startEmitted && signal.aborted) {
      echoGuard.onTtsCancel(cycleId);
    }
    if (!startEmitted) {
      log.debug("drainAudioToWs.no-frames", { sessionId, cycleId, aborted: signal.aborted });
    }
    log.debug("drainAudioToWs.end", {
      sessionId,
      cycleId,
      frameCount,
      bytesSent,
      aborted: signal.aborted,
      elapsedMs: Date.now() - startedAtMs,
    });
  }
}
