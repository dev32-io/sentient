# Gateway Streaming Pipeline Details

Current gateway streaming is native; it does not pass through Hermes ACP or a
Cerebrum event translator.

## Text-to-speech boundary

`gateway/src/tts/text-stream-synthesizer.ts` is the swappable seam between a
turn's text fork and its TTS implementation:

```typescript
interface TextStreamSynthesizer {
  synthesize(
    textStream: AsyncIterable<TtsChunk>,
    signal: AbortSignal,
  ): AsyncIterable<AudioFrame>;
}
```

The input contains streamed text and explicit `FLUSH_SIGNAL` markers. The ReAct
loop emits a flush marker before tool execution so speech can finish the current
text stretch without inventing a protocol-level paragraph or waiting for the
entire turn.

The implementation owns sentence aggregation, text normalization, the provider
session, and audio generation. `turn-voice.ts` owns turn cancellation, client
audio brackets, echo-guard interaction, and aggregate lifecycle logging. It
must not know provider-specific frame formats.

## Composition rules

- Streaming transforms consume and return async iterables.
- Thread the turn's `AbortSignal` through every stage and close upstream
  iterators on cancellation.
- A stage changes only the part of the stream it owns.
- Buffering is internal to the stage that needs it; callers do not special-case
  buffered implementations.
- Provider and socket lifecycle belongs to the adapter/synthesizer boundary,
  not to text transforms.
- Do not log text, chunks, frames, prompts, or audio. Record lengths and
  aggregate counts only at lifecycle boundaries.

The current implementation is under `gateway/src/tts/` and
`gateway/src/runtime/turn-voice.ts`. The broader repository constraints are in
`.claude/rules/gateway/core.md` and `agents/docs/decorator-pattern-details.md`.
