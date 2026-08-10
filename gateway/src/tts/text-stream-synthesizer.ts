import type { TtsChunk } from "./stages/stage-types.ts";

// ---------------------------------------------------------------------------
// TextStreamSynthesizer — the swappable seam between the turn's TTS fork and
// the underlying TTS engine. Single function, two args, one return.
//
// Contract:
//   • Consume `textStream` (text deltas + occasional FLUSH_SIGNAL markers
//     emitted by upstream when the LLM interrupts text to call a tool).
//   • Yield audio frames as they're produced. Backpressure-aware via the
//     async iterator protocol — the consumer (turn-voice) controls pace.
//   • Respect `signal`. On abort: stop reading text, stop yielding frames,
//     release the underlying provider session. Do not throw.
//
// Implementations decide their own preprocessing — sentence aggregation,
// punctuation cleanup, emotion tagging — based on what their engine likes.
// TurnVoice knows nothing about it.
// ---------------------------------------------------------------------------

export interface TextStreamSynthesizer {
  synthesize(textStream: AsyncIterable<TtsChunk>, signal: AbortSignal): AsyncIterable<AudioFrame>;
}

export interface AudioFrame {
  readonly data: Uint8Array;
  readonly encoding: string;
  readonly sampleRate: number;
}
