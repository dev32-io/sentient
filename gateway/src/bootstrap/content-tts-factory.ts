import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import type { TTSProviderFactory } from "../providers/tts/tts-types.ts";
import { createStreamingTtsSynthesizer } from "../tts/streaming-tts-synthesizer.ts";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";

const log = getLog(["sentient", "bootstrap", "text-stream-synthesizer"]);

/**
 * Build a TextStreamSynthesizer for the speak effect.
 * Returns null when TTS or its provider factory is absent (voice disabled).
 */
export function createTextStreamSynthesizer(
  cfg: StartupConfig,
  createTTSProvider: TTSProviderFactory | null,
): TextStreamSynthesizer | null {
  if (!cfg.tts || !createTTSProvider) {
    log.info("tts-disabled", { reason: "tts-absent" });
    return null;
  }

  const { utterance_aggregator: aggregator } = cfg.tts;

  const synth = createStreamingTtsSynthesizer({
    sessionFactory: {
      createSession: async () => createTTSProvider(),
    },
    aggregator: () => ({
      maxBlockChars: aggregator.max_block_chars,
    }),
  });

  log.info("text-stream-synthesizer-created");
  return synth;
}
