# Language-Aware Sentence Aggregator

## Problem

The sentence aggregator splits LLM token streams into sentences for streaming TTS overlap. Current boundary detection only handles English punctuation (`. ! ? \n`). Chinese text (`。！？`) never splits, buffering the entire response until the 2s flush timer — defeating the latency benefit.

Additionally, Fish Audio verbalizes trailing periods as "dot" in streaming mode. The cleanup logic is currently hacked into the aggregator's `enqueue` function rather than being language-specific.

## Approach

Strategy pattern. The aggregator receives a `SentenceBoundaryDetector` that encapsulates language-specific boundary rules and TTS cleanup. A factory resolves language string to concrete detector. Each language is its own file with its own tests.

## Interface

```typescript
// sentence-boundary-detector.ts
export interface SentenceBoundaryDetector {
  /** Returns index just past the first sentence boundary, or -1 if none. */
  detectBoundary(text: string): number;
  /** Clean sentence text before sending to TTS. */
  cleanForTts(sentence: string): string;
}

export function createBoundaryDetector(language: string): SentenceBoundaryDetector;
```

Factory mapping:
- `"zh"` → `createChineseBoundaryDetector()`
- Everything else (including `"en"`, `"multi"`) → `createEnglishBoundaryDetector()`

## Detectors

### English (`en-boundary-detector.ts`)

Extracted from current `sentence-boundary.ts`. No logic changes.

- Boundaries: `.` `!` `?` `\n`
- Guards: abbreviations (dr, mr, mrs, etc.), decimals, ellipsis, URL-like patterns
- Terminal check: boundary char must be followed by whitespace, closing delimiter, or end-of-string
- `cleanForTts`: strip trailing periods (`. → ""`) and punctuation-only sentences

### Chinese (`zh-boundary-detector.ts`)

- Boundaries: `。` `！` `？` `；` `\n`
- No abbreviation or decimal guards needed — CJK punctuation is unambiguous
- Terminal check: boundary char followed by any char or end-of-string
- `cleanForTts`: strip trailing `。`

## Aggregator Changes

`sentence-aggregator.ts`:

```typescript
export interface SentenceAggregatorOptions {
  readonly flushTimeoutMs?: number;
  readonly detector: SentenceBoundaryDetector;
}
```

- `detector` is required (no default)
- `extractSentencesFromBuffer` calls `detector.detectBoundary()` instead of the free function
- `enqueue` calls `detector.cleanForTts()` instead of inline regex
- Remove `TRAILING_PERIODS` regex and `HAS_WORD_CHAR` check from enqueue — detectors handle this in `cleanForTts`

## Wiring

Language flows from session config through the pipeline:

```
index.ts
  reads STT_LANGUAGE env var (future: persona.md per-session)
  passes to PipelineDeps as `language: string`

continuous-voice-handler.ts
  PipelineDeps.language passed to runTurn()

voice-turn.ts
  runVoiceTurn({ ..., language })
  passes to createStreamingOverlap(ttsProcessor, { language })

streaming-overlap.ts
  createStreamingOverlap(ttsProcessor, options)
  creates detector via createBoundaryDetector(options.language)
  creates aggregator via createSentenceAggregator({ detector })
```

## File Layout

```
gateway/src/pipeline/processors/
  sentence-boundary-detector.ts       — interface + factory
  en-boundary-detector.ts             — English detector
  en-boundary-detector.test.ts        — English tests (migrated from sentence-boundary.test.ts)
  zh-boundary-detector.ts             — Chinese detector
  zh-boundary-detector.test.ts        — Chinese tests
  sentence-aggregator.ts              — updated: takes detector option
  sentence-aggregator.test.ts         — updated: injects detector
  sentence-boundary.ts                — deleted
  sentence-boundary.test.ts           — deleted
```

## Testing

### English detector tests
- Migrated from existing `sentence-boundary.test.ts`
- Added: `cleanForTts` strips trailing periods, rejects punctuation-only strings

### Chinese detector tests
- `。` splits: `"你好。世界"` → boundary after `。`
- `！` splits: `"你好！"` → boundary after `！`
- `？` splits: `"你好吗？"` → boundary after `？`
- Mixed text: English periods inside Chinese text don't false-split
- `cleanForTts` strips trailing `。`
- Newline splits same as English

### Aggregator tests
- Updated to pass `createEnglishBoundaryDetector()` as detector
- One test with Chinese detector verifying different split behavior

### Integration tests
- `streaming-overlap.test.ts` updated to pass language option
- `voice-turn.test.ts` updated to pass language
