import { getLog } from "../../logging/logger.ts";
import { type EmotionTaggerOptions, type TagTurn, tagBlocks } from "../../tts/stages/emotion-tagger.ts";
import type { TtsChunk } from "../../tts/stages/stage-types.ts";
import { type UtteranceAggregatorOptions, aggregateUtterances } from "../../tts/stages/utterance-aggregator.ts";
import type { AudioFrame, TextStreamSynthesizer } from "../../tts/text-stream-synthesizer.ts";
import type { TTSProvider } from "./tts-types.ts";

const log = getLog(["sentient", "providers", "tts", "fish-audio-synthesizer"]);

// ---------------------------------------------------------------------------
// FishAudioStreamSynthesizer — concrete TextStreamSynthesizer for Fish Audio.
//
// Pipeline inside:
//   text deltas → UtteranceAggregator → optional EmotionTagger → TTSProvider.pushText
// Concurrent: provider.audioFrames(signal) drains as frames are produced.
//
// The handler (speak-effect.ts) sees only frames in / frames out. Aggregation,
// tagging, paragraph separators, and provider-specific session management
// live entirely in this file.
// ---------------------------------------------------------------------------

export interface FishAudioSynthesizerDeps {
  readonly sessionFactory: TTSSessionFactory;
  /** Builds a per-session aggregator options bag. Called once per synthesize() run. */
  readonly aggregator: () => UtteranceAggregatorOptions;
  /** Optional emotion-tag preprocessor applied before pushText(). */
  readonly emotionTags?: EmotionTaggerOptions;
}

export interface TTSSessionFactory {
  createSession(): Promise<TTSProvider>;
}

export function createFishAudioSynthesizer(deps: FishAudioSynthesizerDeps): TextStreamSynthesizer {
  return {
    synthesize(textStream: AsyncIterable<TtsChunk>, signal: AbortSignal): AsyncIterable<AudioFrame> {
      return synthesizeImpl(textStream, signal, deps);
    },
  };
}

async function* synthesizeImpl(
  textStream: AsyncIterable<TtsChunk>,
  signal: AbortSignal,
  deps: FishAudioSynthesizerDeps,
): AsyncGenerator<AudioFrame> {
  log.info("synthesize-start");
  if (signal.aborted) {
    log.debug("aborted-before-start");
    return;
  }

  const session = await deps.sessionFactory.createSession();
  session.warmup();

  let blocksFed = 0;
  let frameCount = 0;

  // Background producer: aggregate text deltas → optional tag → pushText.
  // We don't await this here; we drain frames in the foreground.
  const producer = (async () => {
    try {
      const blocks = aggregateUtterances(textStream, deps.aggregator(), signal);
      let priorTurns: readonly TagTurn[] = [];
      let firstPush = true;

      for await (const rawBlock of blocks) {
        if (signal.aborted) break;

        const tagged = await tagIfEnabled(rawBlock, priorTurns, deps, signal);
        priorTurns = tagged.nextTurns;
        const cleaned = stripEdgePauses(tagged.text);
        if (cleaned.length === 0) {
          log.debug("block-skip-empty-after-strip", { blockIndex: blocksFed });
          continue;
        }

        if (firstPush) {
          try {
            await session.ready(signal);
          } catch (err: unknown) {
            log.error("session-ready-failed", {
              message: err instanceof Error ? err.message : String(err),
            });
            session.dispose();
            return;
          }
          firstPush = false;
        }

        // Re-introduce paragraph break Fish Audio uses for prosodic gap.
        const sent = `${cleaned}\n\n`;
        log.debug("block-push", {
          blockIndex: blocksFed,
          rawChars: rawBlock.length,
          sentChars: sent.length,
          preview: sent.length <= 120 ? sent : `${sent.slice(0, 120)}…`,
        });
        session.pushText(sent);
        blocksFed += 1;
      }
    } catch (err: unknown) {
      log.error("producer-error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.endInput();
      log.debug("producer-end-input", { blocksFed });
    }
  })();

  try {
    for await (const chunk of session.audioFrames(signal)) {
      if (signal.aborted) break;
      const frame: AudioFrame = {
        data: chunk.data,
        encoding: chunk.encoding,
        sampleRate: chunk.sampleRate,
      };
      frameCount += 1;
      log.debug("frame-yield", { byteSize: frame.data.byteLength, encoding: frame.encoding });
      yield frame;
    }
  } finally {
    if (signal.aborted) {
      log.info("synthesize-aborted", { frameCount, blocksFed });
      session.dispose();
    } else {
      log.info("synthesize-done", { frameCount, blocksFed });
    }
    // Make sure producer exits. It listens to signal too.
    await producer.catch(() => {
      /* logged */
    });
  }
}

async function tagIfEnabled(
  rawBlock: string,
  priorTurns: readonly TagTurn[],
  deps: FishAudioSynthesizerDeps,
  signal: AbortSignal,
): Promise<{ text: string; nextTurns: readonly TagTurn[] }> {
  if (!deps.emotionTags) {
    return { text: rawBlock, nextTurns: priorTurns };
  }
  const result = await tagBlocks([rawBlock], priorTurns, deps.emotionTags, signal);
  return { text: result.tagged[0] ?? rawBlock, nextTurns: result.nextTurns };
}

// ---------------------------------------------------------------------------
// Defensive pause-tag stripping at block edges.
// The emotion-tag prompt forbids leading/trailing pause tags, but the model
// can still drift — this strip is a safety net.
// ---------------------------------------------------------------------------

const PAUSE_TAG_NAME = /\[(?:pause|short pause|long pause|停顿 | 短停顿 | 长停顿)\]/i;
const LEADING_PAUSE_RE = new RegExp(`^(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+`, "i");
const TRAILING_PAUSE_RE = new RegExp(`(?:\\s*${PAUSE_TAG_NAME.source}\\s*)+$`, "i");

function stripEdgePauses(s: string): string {
  return s.replace(LEADING_PAUSE_RE, "").replace(TRAILING_PAUSE_RE, "").trim();
}
