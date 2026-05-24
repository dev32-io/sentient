import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import type { LLMProvider } from "../providers/llm-types.ts";
import { createFishAudioSynthesizer } from "../providers/tts/fish-audio-synthesizer.ts";
import type { TTSProviderFactory } from "../providers/tts/tts-types.ts";
import type { EmotionTaggerOptions } from "../tts/stages/emotion-tagger.ts";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";

const log = getLog(["sentient", "bootstrap", "text-stream-synthesizer"]);

/**
 * Build a TextStreamSynthesizer for the speak effect.
 * Returns null when TTS or its provider factory is absent (voice disabled).
 */
export function createTextStreamSynthesizer(
  cfg: StartupConfig,
  llmProvider: LLMProvider | null,
  createTTSProvider: TTSProviderFactory | null,
): TextStreamSynthesizer | null {
  if (!cfg.tts || !createTTSProvider) {
    log.info("tts-disabled", { reason: "tts-absent" });
    return null;
  }

  const { utterance_aggregator: aggregator, emotion_tags: emotionCfg } = cfg.tts;
  const runtimeDir = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
  const tagSetPath = join(runtimeDir, "prompts", `fish-audio-emotion-tags-${cfg.language}.md`);

  let emotionTags: EmotionTaggerOptions | undefined;
  if (emotionCfg.enabled && llmProvider) {
    try {
      const systemPrompt = readFileSync(tagSetPath, "utf-8");
      emotionTags = {
        llmProvider,
        model: emotionCfg.model,
        systemPrompt,
        timeoutMs: emotionCfg.timeout_ms,
      };
      log.info("emotion-tag-set-loaded", {
        path: tagSetPath,
        promptChars: systemPrompt.length,
        model: emotionCfg.model,
        timeoutMs: emotionCfg.timeout_ms,
      });
    } catch (err: unknown) {
      log.warn("emotion-tag-set-missing", {
        path: tagSetPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log.info("emotion-tagging-disabled", {
      enabled: emotionCfg.enabled,
      hasLlm: llmProvider !== null,
    });
  }

  const synth = createFishAudioSynthesizer({
    sessionFactory: {
      createSession: async () => createTTSProvider(),
    },
    aggregator: () => ({
      maxBlockChars: aggregator.max_block_chars,
    }),
    ...(emotionTags ? { emotionTags } : {}),
  });

  log.info("text-stream-synthesizer-created");
  return synth;
}
