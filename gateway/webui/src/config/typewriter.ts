/**
 * Typewriter reveal tunables. All four rate values are user-perceptual and
 * should be tuned from observed UX, not code review. Pauses are millisecond
 * holds at sentence/paragraph boundaries.
 *
 * See docs/superpowers/specs/2026-04-20-streaming-typewriter-design.md.
 */
export const TYPEWRITER = {
  /**
   * chars/sec at steady state. Tuned to roughly 2× TTS speaking speed
   * (≈15 c/s for Fish Audio at default rate), so the bubble keeps a
   * slight lead on audio playback without racing ahead.
   */
  baseRate: 30,
  /** Floor — never reveal slower than this. Below speaking speed feels stalled. */
  minRate: 15,
  /** Ceiling — burst rate when buffer is far ahead or draining after complete. */
  maxRate: 150,
  /** Each char of buffer-gap adds this fraction to the base rate. 0.02 = +2%/char. */
  gapGain: 0.02,
  /** Hold duration (ms) after a sentence-ending character (`.`, `!`, `?`) followed by whitespace. */
  sentencePauseMs: 80,
  /** Hold duration (ms) after a paragraph break (`\n\n`). */
  paragraphPauseMs: 220,
} as const;

export type TypewriterConfig = typeof TYPEWRITER;
