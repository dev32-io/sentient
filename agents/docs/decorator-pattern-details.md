# Decorator-Pattern Pipeline — Details & Examples

## Decorator Unit Contract

Every unit follows the same shape: async generator in, async generator out. The chunk type is defined by the pipeline's contract — units process only the fields they own and pass through everything else.

### Good — Unit modifies only its responsible field

```typescript
// Voice pipeline contract example
interface PipelineChunk {
  display: string;  // for UI text rendering
  speech: string;   // for TTS audio generation
}

// tts-text-sanitizer.ts — only touches .speech
async function* sanitizeForTts(
  input: AsyncGenerator<PipelineChunk>,
  signal: AbortSignal,
): AsyncGenerator<PipelineChunk> {
  for await (const chunk of input) {
    if (signal.aborted) return;
    yield { ...chunk, speech: stripMarkdown(chunk.speech) };
  }
}
```

### Good — Terminal stage (converts stream type)

```typescript
// tts-stage.ts — consumes .speech, yields AudioFrame
async function* textToAudio(
  input: AsyncGenerator<PipelineChunk>,
  signal: AbortSignal,
): AsyncGenerator<AudioFrame> {
  for await (const sentence of aggregateSentences(input, signal)) {
    if (signal.aborted) return;
    for await (const frame of ttsService.synthesize(sentence, signal)) {
      if (signal.aborted) return;
      yield frame;
    }
  }
}
```

### Bad — Unit modifies fields it doesn't own

```typescript
// WRONG: sanitizer should not touch .display
yield { display: stripMarkdown(chunk.display), speech: stripMarkdown(chunk.speech) };
```

### Bad — Unit with non-standard interface

```typescript
// WRONG: accepts string[], not AsyncGenerator
function processBatch(texts: string[]): string[] {
  return texts.map(stripMarkdown);
}
```

## Composing Units

Units chain by feeding one generator into the next.

```typescript
function buildPipeline(chunks: AsyncGenerator<PipelineChunk>, signal: AbortSignal): AsyncGenerator<AudioFrame> {
  const sanitized = sanitizeForTts(chunks, signal);
  // future: const formatted = ttsFormatter(sanitized, signal);
  return textToAudio(sanitized, signal);
}
```

Adding a new stage is one line — plug it between existing units.

## Self-Contained Black Boxes

A unit that needs full context buffers internally. The pipeline does not change shape.

### Good — Buffering unit (future TTS formatter)

```typescript
async function* ttsFormatter(
  input: AsyncGenerator<PipelineChunk>,
  signal: AbortSignal,
): AsyncGenerator<PipelineChunk> {
  // Phase 1: buffer full text from upstream
  let fullSpeech = "";
  const displayChunks: string[] = [];
  for await (const chunk of input) {
    if (signal.aborted) return;
    fullSpeech += chunk.speech;
    displayChunks.push(chunk.display);
  }

  // Phase 2: transform .speech and re-stream (display passes through as-is)
  const formatted = await llmService.format(fullSpeech, signal);
  const sentences = splitSentences(formatted);
  for (let i = 0; i < sentences.length; i++) {
    if (signal.aborted) return;
    yield { display: displayChunks[i] ?? "", speech: sentences[i] };
  }
}
```

The pipeline doesn't know this unit buffers. From outside: stream in, stream out.

### Bad — Pipeline aware of buffering

```typescript
// WRONG: pipeline logic decides when to buffer
if (needsFormatting) {
  const fullText = await collectAll(tokens);
  const formatted = await formatForTts(fullText);
  return textToAudio(toStream(formatted), signal);
} else {
  return textToAudio(tokens, signal);
}
```

## Dependency Injection

Units declare what they need. The flow manager provides it.

### Good — Unit receives abstract service

```typescript
interface TTSStageConfig {
  ttsService: TTSService;        // abstract interface
  sentenceAggregator: SentenceAggregator;
}

function createTTSStage(config: TTSStageConfig): AudioTransform {
  return async function* (input, signal) {
    // uses config.ttsService — doesn't know if it's Fish Audio, Cartesia, or a mock
  };
}
```

### Bad — Unit creates its own connections

```typescript
// WRONG: unit owns connection lifecycle
function createTtsFormatter(): TextTransform {
  const llm = new OpenRouterClient(process.env.API_KEY); // VIOLATION
  return async function* (input, signal) { /* ... */ };
}
```

## Flow Manager Responsibilities

The flow manager holds service instances and unit instances for the lifetime of a pipeline run.

```typescript
// Pipeline start — parallel init
const [sttReady, ttsReady] = await Promise.all([
  sttService.init(sttConfig, signal),
  ttsService.init(ttsConfig, signal),
]);

// Compose the pipeline
const pipeline = buildPipeline(llmTokens, runSignal);

// Abort cascades through signal; services handle cleanup
runController.abort();
```

The manager calls `init()` on services before the pipeline needs them. Services are warm and ready when the first data arrives.

## AbortSignal Handling

### Good — Clean exit on abort

```typescript
async function* sanitize(input: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<string> {
  for await (const chunk of input) {
    if (signal.aborted) return;  // stop consuming
    yield clean(chunk);           // stop yielding
  }
}
```

### Bad — Throwing on abort

```typescript
async function* sanitize(input: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<string> {
  for await (const chunk of input) {
    if (signal.aborted) throw new Error("Aborted"); // WRONG: return, don't throw
    yield clean(chunk);
  }
}
```

## Buffer Sizing

Pre-allocate generously. Grow early. Reset between runs.

```typescript
const INITIAL_CAPACITY = 600;  // e.g., 120s at 200ms chunks
const GROW_THRESHOLD = 0.5;    // double at 50% fill

function createChunkQueue<T>(initialCapacity: number): ChunkQueue<T> {
  let buffer: (T | undefined)[] = new Array(initialCapacity);
  let head = 0;
  let tail = 0;
  let size = 0;

  function enqueue(item: T): void {
    if (size >= buffer.length * GROW_THRESHOLD) {
      grow();
    }
    buffer[tail] = item;
    tail = (tail + 1) % buffer.length;
    size++;
  }

  function grow(): void {
    const newBuffer = new Array(buffer.length * 2);
    for (let i = 0; i < size; i++) {
      newBuffer[i] = buffer[(head + i) % buffer.length];
    }
    buffer = newBuffer;
    head = 0;
    tail = size;
  }

  function reset(): void {
    buffer = new Array(initialCapacity);
    head = 0;
    tail = 0;
    size = 0;
  }

  return { enqueue, reset, /* ... */ };
}
```

### Bad — Unbounded array

```typescript
// WRONG: no pre-allocation, no growth strategy, no reset
const pending: Chunk[] = [];
pending.push(chunk);
```

## Service Connection Per Pipeline Run

### Good — One connection per run, pre-warmed

```
Run 1: [pre-warmed connection] → text₁ → text₂ → text₃ → stop → finish → close
Run 2: [pre-warmed connection] → text₁ → text₂ → stop → finish → close
```

### Bad — One connection per item

```
Run 1: [connect] text₁ [close] → [connect] text₂ [close] → [connect] text₃ [close]
        200-2000ms overhead PER sentence
```

## Parallel Service Initialization

### Good — Parallel with state tracking

```typescript
await Promise.all([
  sttService.init(config.stt, signal),
  ttsService.init(config.tts, signal),
]);
// State machine: "initializing" → "ready"
```

### Bad — Sequential init

```typescript
// WRONG: TTS waits for STT to finish before starting
await sttService.init(config.stt, signal);
await ttsService.init(config.tts, signal);
```
