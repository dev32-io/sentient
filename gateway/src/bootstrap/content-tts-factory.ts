import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { createStreamingTtsSynthesizer } from "../tts/streaming-tts-synthesizer.ts";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { TTSSessionOpener } from "./tts-factory.ts";

const log = getLog(["sentient", "bootstrap", "text-stream-synthesizer"]);

/**
 * Build a TextStreamSynthesizer for the speak effect.
 * Returns null when TTS or its provider factory is absent (voice disabled).
 */
export function createTextStreamSynthesizer(
  cfg: StartupConfig,
  openTTSSession: TTSSessionOpener | null,
): TextStreamSynthesizer | null {
  if (!cfg.tts || !openTTSSession) {
    log.info("tts-disabled", { reason: "tts-absent" });
    return null;
  }

  const synth = createStreamingTtsSynthesizer({
    sessionFactory: {
      // Awaited: the opener reads the user's voice pack from their profile
      // here, at open time, rather than from a session-held copy.
      createSession: () => openTTSSession(),
    },
  });

  log.info("text-stream-synthesizer-created");
  return synth;
}
