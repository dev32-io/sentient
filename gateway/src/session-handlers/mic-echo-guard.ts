// Mic echo guard — hard-mute the STT uplink for a cooldown window at TTS
// start so the client's WebRTC AEC converges on the initial burst.
// `stt.tts_echo_cooldown_ms` (config.yaml) is the window; residual echo past
// it is handled at the client edge (RNNoise + speech-prob gate), so there is
// no gateway-side energy gate.
//
// Implements runtime/turn-voice.ts's MicEchoGuard: the interface lives with
// its consumer (the runtime), the implementation with the resource it drives
// (the WS-layer STT session). Dependencies point inward.

import { getLog } from "../logging/logger.js";
import type { MicEchoGuard } from "../runtime/turn-voice.js";
import type { SttSession } from "./stt-session.js";

const log = getLog(["sentient", "session-handlers", "mic-echo-guard"]);

const CLEAR_SUPPRESSION_MS = 0;

/**
 * @param getStt   read lazily — the STT session is minted on the first
 *                 `audio.start`, which may be long after this guard is built.
 * @param cooldownMs `null` when the gateway has no `stt:` config (nothing to
 *                 suppress); otherwise `stt.tts_echo_cooldown_ms`.
 */
export function createMicEchoGuard(
  getStt: () => SttSession | null,
  cooldownMs: number | null,
  sessionId: string,
): MicEchoGuard {
  return {
    onTtsStart(turnId) {
      if (cooldownMs === null) return;
      const stt = getStt();
      if (!stt) return;
      stt.suppressInputFor(cooldownMs);
      log.info("mic-suppress.tts-start", { sessionId, turnId, cooldownMs });
    },
    onTtsCancel(turnId) {
      const stt = getStt();
      if (!stt) return;
      stt.suppressInputFor(CLEAR_SUPPRESSION_MS);
      log.info("mic-suppress.cleared", {
        sessionId,
        turnId,
        reason: "tts cancelled — the user is speaking, their frames must reach STT now",
      });
    },
  };
}
