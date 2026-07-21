/**
 * Out-of-band marker that flows alongside text deltas through the TTS pipeline
 * and tells downstream stages "flush whatever you've been holding". Emitted by
 * the broadcaster when the LLM stops streaming text to call a tool, so a short
 * pre-tool acknowledgement ("Let me check.") isn't held back for the seconds
 * the tool takes to return. Markdown stripping, emoji stripping, and
 * paragraph-aggregation now happen service-side in local-tts (which owns the
 * full text frontend); the gateway forwards raw text deltas plus this marker.
 *
 * It is a unique symbol — never collides with any string payload — and every
 * stage in the chain must pass it through unchanged (after flushing its own
 * internal buffer, if any).
 */
export const FLUSH_SIGNAL: unique symbol = Symbol("tts.flush-signal");
export type FlushSignal = typeof FLUSH_SIGNAL;

/** Item flowing through the TTS text pipeline: a text delta, or a flush marker. */
export type TtsChunk = string | FlushSignal;
