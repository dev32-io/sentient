# TTS Emotion Tag Processor Design

## Summary

Add a `TtsEmotionTagProcessor` decorator unit to the voice pipeline that uses a cheap LLM (via OpenRouter) to annotate text with Fish Audio S2-Pro emotion/prosody tags before TTS synthesis. This also flattens `StreamingOverlap` into three independent decorator units, proving the pipeline's composability for Phase 4/5.

## Pipeline Architecture

### Current

```
LLM tokens → StreamingOverlap (SentenceAggregator + TTS orchestration) → Fish Audio
```

### New (flattened)

```
LLM tokens → SentenceAggregator → EmotionTagProcessor → TTSSender
               (TextTransform)      (TextTransform)      (AudioTransform)
```

Each unit is a standalone decorator following the existing `TextTransform` / `AudioTransform` signatures from `pipeline-types.ts`.

## Unit Decomposition

### SentenceAggregator (refactored from existing)

Signature: `TextTransform` — `(AsyncGenerator<PipelineChunk>, AbortSignal) => AsyncGenerator<PipelineChunk>`

Behavior:
- Receives token-level `PipelineChunk` from LLM
- Yields `{ display: token, speech: "" }` immediately (UI pass-through, zero latency)
- Buffers `speech` content internally
- On sentence boundary: yields `{ display: "", speech: "Complete sentence." }`
- On flush (timeout or end-of-stream): yields remaining buffered speech

Uses existing `SentenceBoundaryDetector` for language-aware boundary detection.

### EmotionTagProcessor (new)

Signature: `TextTransform` — `(AsyncGenerator<PipelineChunk>, AbortSignal) => AsyncGenerator<PipelineChunk>`

Factory:
```typescript
function createEmotionTagProcessor(
  llmProvider: LLMProvider,
  model: string,
  tagSet: EmotionTagSet,
): TextTransform
```

Behavior:
- Display-only chunks (`speech: ""`): yield immediately, zero latency impact
- Speech chunks (`display: "", speech: "sentence"`): buffer into paragraph batch
- On paragraph boundary (sentence ending with `\n`) or end-of-stream: flush batch
  - Build prompt: `tagSet.getSystemPrompt()` as system message, paragraph text as user message
  - Call cheap LLM (single non-streaming request, ~100-200ms for Haiku)
  - Yield `{ display: "", speech: taggedParagraph }`
- On AbortSignal: stop buffering, stop LLM calls, return

The LLM call is request/response (not streaming) since TTS needs the complete tagged output.

### TTSSender (extracted from StreamingOverlap)

Signature: `AudioTransform` — `(AsyncGenerator<PipelineChunk>, AbortSignal) => AsyncGenerator<PipelineOutput>`

Behavior:
- Display-only chunks (`speech: ""`): yield as `{ type: "text", display }` events
- First speech chunk: call `ttsProcessor.synthesizeSentence(speech, signal)`, yield audio frames
- Remaining speech chunks: call `ttsProcessor.sendText(speech)`, continue yielding audio
- End of input: call `ttsProcessor.endTurn()`
- Interleaves text and audio events in output

## Abstraction Layer

```typescript
interface EmotionTagSet {
  readonly name: string;       // e.g., "fish-audio-s2"
  readonly language: string;   // "en" | "zh"
  getSystemPrompt(): string;   // full instruction prompt loaded from .md file
}
```

Factory:
```typescript
function loadEmotionTagSet(provider: string, language: string): EmotionTagSet
// loadEmotionTagSet("fish-audio", "en") → loads fish-audio-emotion-tags-en.md
// loadEmotionTagSet("fish-audio", "zh") → loads fish-audio-emotion-tags-zh.md
```

To swap TTS providers: add new prompt files and register the provider name. The processor code does not change.

## Prompt Files

Location: `gateway/src/pipeline/processors/prompts/`

Two files:
- `fish-audio-emotion-tags-en.md` — English tagging instructions
- `fish-audio-emotion-tags-zh.md` — Chinese tagging instructions (native Chinese tags)

### Prompt Structure (both languages)

1. **Role**: Text annotator that inserts emotion/prosody tags for Fish Audio S2-Pro TTS
2. **Syntax rules**: `[bracket]` tags, inline placement, scope behavior
3. **Tag mapping table** organized by category:
   - Emotions: `[excited]`, `[sad]`, `[angry]`, `[happy]`, `[surprised]`, etc.
   - Volume: `[whisper]`, `[low voice]`, `[loud]`, `[shouting]`
   - Pacing: `[pause]`, `[short pause]`, `[long pause]`
   - Vocalizations: `[sigh]`, `[laugh]`, `[inhale]`, `[clearing throat]`
   - Style: `[soft tone]`, `[emphasis]`
4. **Punctuation rules**: Add `[pause]` between sentences where natural, `[long pause]` between paragraphs, breathing tags (`[sigh]`, `[inhale]`) for life-like pacing
5. **When NOT to tag**: Simple factual statements, already-expressive text
6. **Examples**: 3-4 before/after pairs showing plain text vs tagged text
7. **Critical output rule**: Return ONLY the tagged text, no explanation, no markdown

The zh prompt uses native Chinese tags: `[开心]`, `[悲伤]`, `[低声说]`, `[叹气]`, `[停顿]` — S2-Pro has 98.4% activation rate for Chinese tags.

Target: under 200 lines per file. Absolute max: 300 lines.

## Integration Point

In `voice-turn.ts`, the pipeline composition becomes:

```typescript
const sentenceStream = sentenceAggregator(llmToPipelineChunks(), signal);
const taggedStream = emotionTagProcessor(sentenceStream, signal);
const outputStream = ttsSender(taggedStream, signal);

for await (const event of outputStream) {
  // yield text.delta, audio.start, audio.frame, audio.done
}
```

## Configuration

New environment variables:
- `EMOTION_TAG_MODEL` — default `"anthropic/claude-3-haiku"`. The cheap model used for tagging.
- `EMOTION_TAGS_ENABLED` — default `"true"`. Kill switch to bypass the processor.

Uses existing `OPENROUTER_API_KEY` and `LLMProvider` interface. No new provider needed.

## File Plan

| File | Type | Description |
|------|------|-------------|
| `processors/sentence-aggregator.ts` | Refactor | Extract as standalone `TextTransform` with display pass-through |
| `processors/emotion-tag-processor.ts` | New | The emotion tagging decorator unit |
| `processors/tts-sender.ts` | New | TTS orchestration extracted from StreamingOverlap |
| `processors/prompts/fish-audio-emotion-tags-en.md` | New | English tagging prompt |
| `processors/prompts/fish-audio-emotion-tags-zh.md` | New | Chinese tagging prompt |
| `processors/emotion-tag-set.ts` | New | `EmotionTagSet` interface + `loadEmotionTagSet()` factory |
| `pipeline/voice-turn.ts` | Modify | Compose flattened pipeline |
| `processors/streaming-overlap.ts` | Delete | Replaced by SentenceAggregator + TTSSender |
| Test files | New/Refactor | One `.test.ts` per source file |

## Error Handling

- LLM call failure: log warning, pass through untagged text (graceful degradation)
- LLM returns garbage (not just tagged text): log warning, pass through original
- Timeout: LLM call gets same `AbortSignal` as pipeline; aborts cleanly
- Empty paragraph: skip LLM call, yield nothing

## Testing Strategy

- EmotionTagProcessor: mock LLMProvider, verify tagged output, verify display pass-through, verify abort behavior, verify graceful degradation on LLM failure
- SentenceAggregator: verify display pass-through + speech buffering (refactored behavior)
- TTSSender: mock TTSProcessor, verify first-sentence gate, sendText for rest, endTurn
- Integration: end-to-end with mock LLM + mock TTS, verify tagged text reaches TTS
