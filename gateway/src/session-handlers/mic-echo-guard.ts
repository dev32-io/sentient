import type { UserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "session-handlers", "mic-echo-guard"]);

// ---------------------------------------------------------------------------
// Mic echo guard — hard-mute the STT uplink for a cooldown window around
// TTS playback so the browser's WebRTC AEC has time to converge.
//
// Pre-N4 this also ramped a PCM-domain energy threshold up during playback
// and back down at the tail. That gate was removed once the webui edge
// (Phase 5.5 N3) started running RNNoise + a speech-prob gate before the
// opus encoder — residual echo never reaches the gateway anymore. Only the
// start-of-playback hard-mute remains here; the tail/threshold side is gone.
// ---------------------------------------------------------------------------

export interface MicSuppressionOptions {
  readonly echoCooldownMs: number;
}

export interface MicEchoGuard {
  onTtsStart(cycleId: string): void;
  /** TTS finished or was cancelled — currently a no-op (kept for symmetry +
   *  future hooks). The start-side cooldown self-expires; nothing to tear
   *  down. */
  onTtsDone(cycleId: string): void;
  onTtsCancel(cycleId: string): void;
  /** Hard reset on session teardown. */
  dispose(): void;
}

export function createMicEchoGuard(
  audioAdapterRef: () => UserAudioInputAdapter | null,
  opts: MicSuppressionOptions | null,
  sessionId: string,
): MicEchoGuard {
  return {
    onTtsStart(cycleId) {
      const adapter = audioAdapterRef();
      if (!adapter || !opts) return;
      adapter.suppressInputFor(opts.echoCooldownMs);
      log.info("mic-suppress.tts-start", {
        sessionId,
        cycleId,
        cooldownMs: opts.echoCooldownMs,
      });
    },
    onTtsDone(cycleId) {
      log.debug("mic-suppress.tts-done", { sessionId, cycleId });
    },
    onTtsCancel(cycleId) {
      log.debug("mic-suppress.tts-cancel", { sessionId, cycleId });
    },
    dispose() {
      /* nothing to tear down */
    },
  };
}

export function buildMicSuppressionOptions(services: GatewayServices): MicSuppressionOptions | null {
  if (!services.stt) return null;
  return { echoCooldownMs: services.stt.adapterConfig.ttsEchoCooldownMs };
}
