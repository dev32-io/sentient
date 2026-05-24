# Gateway Pipeline — Alternative: Push-Based Frame Processor Pipeline

## Approach Name: `frame-processor-pipeline`

## Key Insight

The codebase already has a complete push-based frame pipeline (`pipeline.ts`, `processor.ts`, `frame-queue.ts`) with typed frames (`AudioFrame`, `TextFrame`, `TranscriptFrame`, `SystemFrame`, `ControlFrame`) — but the voice path **bypasses it entirely** in favor of custom `VoiceTurnEvent` objects and ad-hoc generator orchestration. This alternative explores what happens if we **use the existing infrastructure** instead of replacing it with async generator composition.

## Contrast with Current Approach (async-generator-composition)

| Aspect | Async Generator (current) | Frame Processor (alternative) |
|--------|--------------------------|------------------------------|
| Data flow | Pull-based: downstream pulls from upstream | Push-based: upstream pushes frames through chain |
| Composition | Nested function calls: `tts(agg(llm(input)))` | Linear array: `createPipeline([stt, agg, llm, tts])` |
| Backpressure | Natural via `for await` blocking | Must be explicitly managed (queue + drain) |
| Error propagation | Generator `throw()` propagates through chain | Must be routed through SystemFrame or out-of-band |
| Cancellation | AbortSignal checked at each `yield` | SystemFrame `InterruptionFrame` broadcast to all |
| Streaming overlap | Implicit from pull semantics | Requires explicit parallel routing |
| State per stage | Closure variables in generator | Processor object can hold mutable state |
| Existing code reuse | Supersedes `pipeline.ts` | **Reuses** `pipeline.ts`, `processor.ts`, `frame-queue.ts` |

## Architecture

### Core: Existing `Processor` Interface + Extensions

```typescript
// Already exists in processor.ts
interface Processor {
  readonly name: string;
  push(frame: Frame): Promise<Frame[]>;
  pushSystem(frame: SystemFrame): Promise<void>;
}

// Extension: lifecycle hooks for continuous mode
interface LifecycleProcessor extends Processor {
  start?(ctx: ProcessorContext): Promise<void>;
  stop?(): Promise<void>;
  flush?(): Promise<Frame[]>;  // drain buffered state
}
```

### Pipeline with Lifecycle

```typescript
// Extended from existing createPipeline()
interface ContinuousPipeline extends Pipeline {
  start(ctx: ProcessorContext): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<Frame[]>;  // call flush() on all processors, collect output
}

function createContinuousPipeline(processors: LifecycleProcessor[]): ContinuousPipeline {
  const base = createPipeline(processors);  // reuse existing
  return {
    ...base,
    async start(ctx) {
      for (const p of processors) await p.start?.(ctx);
    },
    async stop() {
      for (const p of [...processors].reverse()) await p.stop?.();
    },
    async flush() {
      let frames: Frame[] = [];
      for (const p of processors) {
        const flushed = await p.flush?.() ?? [];
        frames.push(...flushed);
      }
      return frames;
    },
  };
}
```

### Stage Breakdown (Push Model)

```
  [WS Binary]
       │ push(AudioFrame)
       ▼
  ┌─────────────┐
  │ STTProcessor │  Buffers audio, forwards to STTProvider
  │              │  On transcript event → emits TranscriptFrame
  └──────┬──────┘
         │ push(TranscriptFrame)  ← includes partials!
         ▼
  ┌──────────────────────┐
  │ TranscriptAccumulator │  Collects partials, emits final TextFrame
  └──────┬───────────────┘
         │ push(TextFrame)
         ▼
  ┌──────────────┐
  │ LLMProcessor │  Calls llmProvider.stream(), pushes TextFrame tokens downstream
  └──────┬───────┘
         │ push(TextFrame) per token
         ▼
  ┌────────────────────────┐
  │ SentenceAggregator     │  Existing logic! Buffers tokens → emits TextFrame per sentence
  └──────┬─────────────────┘
         │ push(TextFrame) per sentence
         ▼
  ┌──────────────┐
  │ TTSProcessor │  Calls ttsProvider.synthesize() → emits AudioFrame[]
  └──────┬───────┘
         │ push(AudioFrame)
         ▼
  [WS Binary out]
```

### The Streaming Overlap Problem

This is where push-based gets interesting. In the async-generator model, LLM→TTS overlap is automatic: TTS pulls the next sentence while LLM continues producing tokens. In push-based, we need **explicit parallel routing**.

```typescript
// LLMProcessor: produces tokens asynchronously, pushes downstream
function createLLMProcessor(provider: LLMProvider): LifecycleProcessor {
  let downstream: ((frame: Frame) => Promise<void>) | null = null;

  return {
    name: 'llm',
    async push(frame: Frame): Promise<Frame[]> {
      if (frame.type !== 'text' || !frame.isFinal) return [];
      
      // Stream LLM tokens — push downstream as they arrive
      // Return empty; output goes through downstream callback
      const tokens = provider.stream({ messages: [{ role: 'user', content: frame.text }] });
      // Spawn async producer — does NOT block push()
      spawnTokenPusher(tokens, downstream!);
      return [];
    },

    // Pipeline wires this
    setDownstream(fn: (frame: Frame) => Promise<void>) {
      downstream = fn;
    },
  };
}
```

This introduces a **split in the pipeline model**: synchronous stages return `Frame[]` from `push()`, but async producers (LLM, TTS) need to push asynchronously. This requires a `setDownstream` hook or an internal event bus — **this is the key complexity cost** of push-based.

### Solution: Async Push Processor Variant

```typescript
interface AsyncProcessor extends LifecycleProcessor {
  // For stages that produce output asynchronously (LLM streaming, TTS synthesis)
  // Pipeline wires output to next stage's push()
  onOutput(handler: (frames: Frame[]) => Promise<void>): void;
}
```

The pipeline detects `AsyncProcessor` and wires `onOutput → next.push()` instead of relying on return values. Synchronous processors still use `push() → Frame[]`.

### Barge-In via SystemFrame (Existing!)

The existing `InterruptionFrame` and `clearNonSystem()` on `FrameQueue` are **exactly** the barge-in mechanism:

```typescript
// On barge-in:
pipeline.processSystem({ type: 'system', kind: 'interruption', reason: 'barge-in' });
// Each processor receives it:
// - LLMProcessor: abort current stream
// - SentenceAggregator: flush partial, reset
// - TTSProcessor: abort current synthesis
// - FrameQueue: clearNonSystem() — drop buffered audio
```

No AbortSignal rotation needed. SystemFrame is the cancellation primitive. This is cleaner than the generator approach where each `for await` loop must independently check `signal.aborted`.

### FlowManager (Same Role, Different Wiring)

```typescript
interface FlowManager {
  startSession(config: SessionConfig): Promise<void>;
  endSession(): Promise<void>;
  
  // Push audio into pipeline
  handleAudio(chunk: Uint8Array): void;
  handleUtteranceEnd(): void;
  handleBargeIn(): void;
  
  // Pipeline output — frames emitted from last stage
  onFrame(handler: (frame: Frame) => void): void;
}
```

FlowManager creates the pipeline, wires output to WS, routes incoming audio/events as frames.

## Strengths

1. **Reuses existing infrastructure**: `pipeline.ts`, `processor.ts`, `frame-queue.ts`, frame types — all already built and tested.
2. **Barge-in is native**: `InterruptionFrame` + `clearNonSystem()` is a first-class cancellation model. No AbortSignal threading.
3. **Priority routing built-in**: `FrameQueue` already separates system frames (priority 1) from data frames. Error/cancellation always wins.
4. **Stage isolation is enforced**: Each processor sees only `Frame` in, `Frame[]` out. No shared `ctx.emit()` side-channel needed.
5. **Observable by default**: Pipeline can intercept frames between stages for logging, metrics, debugging — just insert a pass-through processor.
6. **Matches Pipecat/LiveKit model**: Both use push-based frame processors. Community patterns transfer.
7. **Existing tests**: `pipeline.test.ts`, `processor.test.ts`, `frame-queue.test.ts` already cover the base infrastructure.

## Weaknesses

1. **Streaming overlap requires async push**: LLM and TTS are inherently async producers. The synchronous `push() → Frame[]` model breaks for them. Need `AsyncProcessor` variant, adding complexity.
2. **Backpressure is manual**: If TTS is slow, LLM keeps pushing sentences. Need explicit buffering or flow control between async stages. Generator model handles this naturally.
3. **Error propagation is out-of-band**: A provider failure in `LLMProcessor` can't return an error frame from `push()` if the error happens in the async producer. Must route through SystemFrame or a separate error channel.
4. **Frame type proliferation**: Every inter-stage data type must be a Frame variant. Adding new stage types means extending the Frame union. Generator model uses generic type parameters.
5. **Testing async producers is harder**: Must verify that async push sequences arrive in correct order, with correct timing. Generator model's pull semantics make ordering deterministic.
6. **Two processor models**: Having both sync (`push → Frame[]`) and async (`onOutput`) processors complicates the pipeline wiring and makes the mental model less uniform.

## Key Design Decision: Hybrid Push-Pull

The cleanest version might be **push at boundaries, pull internally for async stages**:

```typescript
// Boundary processors (STT, LLM, TTS) use internal async generators
// but expose push interface to pipeline
function createLLMProcessor(provider: LLMProvider): AsyncProcessor {
  const outputQueue = createFrameQueue();
  let producing = false;
  
  return {
    name: 'llm',
    async push(frame) {
      if (frame.type !== 'text') return [];
      // Start async production into queue
      producing = true;
      (async () => {
        for await (const token of provider.stream({ ... })) {
          outputQueue.enqueue({ type: 'text', text: token, isFinal: false });
        }
        outputQueue.enqueue({ type: 'text', text: '', isFinal: true });
        producing = false;
      })();
      return [];  // output arrives via onOutput
    },
    // Pipeline polls or gets notified
    async drain(): Promise<Frame[]> {
      const frames: Frame[] = [];
      while (!outputQueue.isEmpty()) frames.push(outputQueue.dequeue()!);
      return frames;
    },
  };
}
```

This is essentially what `audio-relay-processor.ts` already does — it wraps the STT provider's async generator into a push interface with internal queuing.

## Viability Assessment

**Transferable to real codebase?** Yes, with caveats.

The push-based model is a natural fit for the existing frame infrastructure. The main risk is the async producer problem — LLM and TTS don't fit the synchronous `push → Frame[]` contract. The hybrid approach (push interface, internal async generators) works but loses some of the simplicity benefit.

Compared to async-generator-composition:
- **Better at**: code reuse, barge-in, observability, matching existing patterns
- **Worse at**: streaming overlap, backpressure, async error propagation
- **Similar**: testability, extensibility, provider swapping

The push model is the more conservative choice — it builds on what exists rather than replacing it. The generator model is the more elegant choice for the streaming-heavy pipeline. A real implementation would likely use **both**: push-based frame routing for the outer pipeline, async generators inside provider-wrapping processors.

## Comparison Summary

| Dimension | async-generator-composition | frame-processor-pipeline |
|-----------|---------------------------|-------------------------|
| Code reuse | Supersedes existing infra | Reuses existing infra |
| Streaming overlap | Natural (pull) | Requires async variant |
| Barge-in | AbortSignal threading | SystemFrame broadcast |
| Backpressure | Built-in | Manual |
| Error propagation | Generator throw() | SystemFrame / out-of-band |
| Observability | ctx.emit() side-channel | Inter-stage frame interception |
| Community precedent | Deno/Node stream pipelines | Pipecat/LiveKit frame model |
| Mental model | Uniform pull | Split sync/async push |
| Testability | Mock async iterables | Mock Frame sequences |
