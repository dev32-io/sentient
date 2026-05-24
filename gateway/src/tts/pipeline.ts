import { getLog } from "../logging/logger.js";
import type { BargeInGateControls } from "./stages/barge-in-gate.js";
import { createBargeInGate } from "./stages/barge-in-gate.js";
import { createEmojiStripper } from "./stages/emoji-stripper.js";
import { tagBlocks } from "./stages/emotion-tagger.js";
import type { EmotionTaggerDeps, TagTurn } from "./stages/emotion-tagger.js";
import { createMarkdownStripper } from "./stages/markdown-stripper.js";
import { composeTextStages } from "./stages/stage-types.js";
import type { TtsChunk } from "./stages/stage-types.js";
import { aggregateUtterances } from "./stages/utterance-aggregator.js";
import type { UtteranceAggregatorOptions } from "./stages/utterance-aggregator.js";
import type { TextStreamSynthesizer } from "./text-stream-synthesizer.js";

const log = getLog(["sentient", "tts", "pipeline"]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TtsPipelineDeps {
  synthesizer: TextStreamSynthesizer;
  emotionTaggerDeps: EmotionTaggerDeps | null;
  aggregator: UtteranceAggregatorOptions;
  markdownStripping: boolean;
  emojiStripping: boolean;
}

export interface TtsPipelineControls extends BargeInGateControls {}

export interface TtsPipelineRun {
  done: Promise<void>;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the TTS pipeline: strip → gate → aggregate → tag → synthesize.
 *
 * Returns a handle that resolves when audio playback finishes or cancel()
 * is called. Caller serializes by cycle so audio doesn't overlap.
 */
export function runTtsPipeline(
  textDeltas: AsyncIterable<TtsChunk>,
  controls: TtsPipelineControls,
  deps: TtsPipelineDeps,
  cycleId: string,
  signal: AbortSignal,
): TtsPipelineRun {
  log.debug("run.start", { cycleId });

  const stages = [];
  stages.push(createBargeInGate(controls));
  if (deps.markdownStripping) stages.push(createMarkdownStripper());
  if (deps.emojiStripping) stages.push(createEmojiStripper());
  const stripChain = composeTextStages(...stages);

  const stripped = stripChain(textDeltas, signal);
  const blocks = aggregateUtterances(stripped, deps.aggregator, signal);

  const audioFrames = deps.synthesizer.synthesize(
    enrichWithEmotionTags(blocks, deps.emotionTaggerDeps, signal),
    signal,
  );

  const done = drainFrames(audioFrames, signal, cycleId);

  return {
    done,
    cancel: () => {
      log.debug("run.cancel", { cycleId });
    },
  };
}

// ---------------------------------------------------------------------------
// Emotion tag adapter
// ---------------------------------------------------------------------------

async function* enrichWithEmotionTags(
  blocks: AsyncGenerator<string>,
  emotionDeps: EmotionTaggerDeps | null,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!emotionDeps) {
    yield* blocks;
    return;
  }

  let priorTurns: readonly TagTurn[] = [];
  for await (const block of blocks) {
    if (signal.aborted) return;
    const result = await tagBlocks([block], priorTurns, emotionDeps, signal);
    priorTurns = result.nextTurns;
    const tagged = result.tagged[0] ?? block;
    log.debug("emotion-tag", { rawLen: block.length, taggedLen: tagged.length });
    yield tagged;
  }
}

// ---------------------------------------------------------------------------
// Frame drain helper
// ---------------------------------------------------------------------------

async function drainFrames(frames: AsyncIterable<unknown>, signal: AbortSignal, cycleId: string): Promise<void> {
  let frameCount = 0;
  try {
    for await (const _ of frames) {
      if (signal.aborted) break;
      frameCount++;
    }
  } catch (err: unknown) {
    log.debug("drain.error", { cycleId, err: err instanceof Error ? err.message : String(err) });
  } finally {
    log.debug("run.end", { cycleId, frameCount, aborted: signal.aborted });
  }
}
