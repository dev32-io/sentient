/**
 * Out-of-band marker that flows alongside text deltas through the TTS pipeline
 * and tells downstream stages "flush whatever you've been holding". Emitted by
 * the broadcaster when the LLM stops streaming text to call a tool, so the
 * utterance aggregator doesn't sit on a short pre-tool acknowledgement
 * ("Let me check.") for the seconds the tool takes to return.
 *
 * It is a unique symbol — never collides with any string payload — and every
 * stage in the chain must pass it through unchanged (after flushing its own
 * internal buffer, if any).
 */
export const FLUSH_SIGNAL: unique symbol = Symbol("tts.flush-signal");
export type FlushSignal = typeof FLUSH_SIGNAL;

/** Item flowing through the TTS text pipeline: a text delta, or a flush marker. */
export type TtsChunk = string | FlushSignal;

/**
 * A text-domain decorator unit in the TTS pipeline.
 *
 * Rules (from .claude/rules/pipeline.md):
 * - AsyncGenerator in, AsyncGenerator out.
 * - One responsibility per unit.
 * - Pass FLUSH_SIGNAL through (after flushing internal buffer, if any).
 * - Respects AbortSignal — stops consuming, stops yielding, releases buffers,
 *   does NOT throw.
 * - Internal buffering is its own business; does not own service lifecycle.
 */
export type TextStage = (input: AsyncIterable<TtsChunk>, signal: AbortSignal) => AsyncGenerator<TtsChunk>;

/**
 * Compose stages left-to-right: s1 → s2 → s3.
 */
export function composeTextStages(...stages: TextStage[]): TextStage {
  return (input, signal) => {
    let current: AsyncIterable<TtsChunk> = input;
    for (const s of stages) current = s(current, signal);
    return (async function* () {
      for await (const chunk of current) {
        if (signal.aborted) return;
        yield chunk;
      }
    })();
  };
}
