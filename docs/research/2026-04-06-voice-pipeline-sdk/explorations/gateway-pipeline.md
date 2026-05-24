# Gateway Pipeline — Stateless Stage Composition

## Current Architecture

### File Map & Responsibilities

```
gateway/src/
├── server/
│   ├── ws-server.ts          — Bun WS server, message routing, session lifecycle
│   └── voice-handlers.ts     — Turn orchestration, transcript reading, WS message serialization
└── pipeline/
    ├── pipeline.ts           — Generic Frame→Processor chain (UNUSED by voice path)
    ├── processor.ts          — Processor interface: push(Frame)→Frame[] (UNUSED by voice path)
    ├── frame-queue.ts        — Priority queue: SystemFrame > DataFrame (UNUSED by voice path)
    ├── voice-session.ts      — STT/TTS connection lifecycle, audio buffering, turn management
    ├── voice-turn.ts         — LLM→StreamingOverlap→TTS, yields VoiceTurnEvent
    ├── barge-in/
    │   └── barge-in-controller.ts — AbortSignal rotation + callback notification
    └── processors/
        ├── streaming-overlap.ts      — Parallel LLM→SentenceAggregator→TTS
        ├── sentence-aggregator.ts    — Token buffer → sentence boundary → async generator
        ├── sentence-boundary.ts      — Punctuation/abbreviation-aware split detection
        ├── tts-processor.ts          — TTSProvider → AudioFrame adapter (stateless, clean)
        └── audio-relay-processor.ts  — STT audio forwarding + transcript queue relay
```

### End-to-End Turn Lifecycle

```
[Client: audio.start]
  → voice-handlers.handleVoiceStart()
    → voiceSession.startRecording()  [connect STT+TTS if needed, buffer early audio]
    → voiceSession.prepareForNewTurn() [flush stale transcript queue]

[Client: binary audio frames]
  → ws-server.ts:164-166 → voiceSession.sendAudio()
    → sttProvider.sendAudio(chunk) [or early buffer if still connecting]

[Client: audio.end]
  → voice-handlers.handleVoiceEnd()
    → voiceSession.finishAudio() [sttProvider.finalize()]
    → voiceSession.beginTurn()  [create AbortController]
    → readTranscriptOrNull()    [wait for isFinal:true transcript event]
    → runVoiceTurn(13-field options bag)
      → ContextAssembler.buildMessages() [history → LLM prompt]
      → llmProvider.stream() → AsyncGenerator<string>
      → StreamingOverlap.process():
        → spawn background LLM consumer → SentenceAggregator.addToken()
        → SentenceAggregator.sentences() yields complete sentences
        → for each sentence: TTSProcessor.synthesizeSentence() → AudioFrame[]
      → yield VoiceTurnEvent (text.delta | text.done | audio.start | audio.frame | audio.done)
    → streamVoiceTurnEvents() [convert VoiceTurnEvent → WS JSON/binary messages]
    → ws.data.history.push() [append to conversation]

[Client: barge_in]
  → voiceSession.bargeIn() → AbortController.abort()
```

### What Already Exists But Is Unused

The codebase has a **complete frame-based pipeline infrastructure** that the voice path ignores:

1. **`pipeline.ts` + `processor.ts`** — Generic `Processor` interface with `push(Frame) → Frame[]` and `pushSystem(SystemFrame)`, chained by `createPipeline()`. Tests exist. Voice path bypasses this entirely.

2. **`frame-queue.ts`** — Priority-aware queue separating SystemFrame (priority 1) from DataFrame/ControlFrame. Has `clearNonSystem()` for barge-in. Not used in voice flow.

3. **`audio-relay-processor.ts`** — Bridge between DataFrame model and STTProvider. Already converts TranscriptEvent→TranscriptFrame, has its own async generator `transcriptFrames()`, handles interruption cleanup. This is the closest existing code to the composable stage pattern.

4. **Protocol frame types** (`shared/protocol/src/frames.ts`) — `AudioFrame`, `TextFrame`, `TranscriptFrame`, `SystemFrame`, `ControlFrame` all defined. Voice path uses custom `VoiceTurnEvent` union instead.

## Current Pain Points (Specific)

### 1. voice-handlers.ts — Monolith Orchestrator

`handleVoiceEnd()` is ~50 lines of sequential orchestration that couples:
- VoiceSession lifecycle calls
- Transcript reading (with no timeout — can hang forever)
- VoiceTurn creation (13-field options bag)
- WS message serialization
- History management

Cannot test turn execution without mock WS. Cannot swap orchestration logic without touching all of it.

### 2. voice-session.ts — 7 Mutable Closure Variables

```typescript
let isClosed = false;
let sttConnected = false;
let ttsConnected = false;
let sttConnectController: AbortController;
let ttsConnectController: AbortController;
let activeTurnController: AbortController | null;
let earlyAudioBuffer: Uint8Array[];
let connectPromise: Promise<void> | null;
```

This is an implicit state machine with no defined states or transitions. Connection coordination uses promise swapping (`connectPromise`). Audio buffering during connect is a side effect. AbortController ownership is split between session and caller.

### 3. voice-turn.ts — Tightly Coupled, Untestable in Isolation

`runVoiceTurn()` accepts 13 fields and couples:
- History building (ContextAssembler)
- LLM streaming
- Text buffering with manual index tracking
- StreamingOverlap creation
- Audio start/done event emission via callback

The "text buffer tap" pattern (lines 33-38) manually tracks token consumption via shared mutable `textBuffer[]` + `textIndex` across generator and callback.

### 4. streaming-overlap.ts — Callbacks Break Event Model

Uses `onAudioStart(cb)` / `onAudioDone(cb)` callback mutation instead of yielding events through the generator. Error from background LLM consumer is captured into `llmError` variable and only surfaced after sentence generator exhausts — non-obvious error propagation.

### 5. Provider Lifecycle Inconsistency

| Provider | connect() | disconnect() | Per-turn method | Lifecycle |
|----------|-----------|---------------|-----------------|-----------|
| STT      | yes       | yes           | sendAudio/finalize/transcripts | Full stateful |
| TTS      | yes       | yes           | synthesize()    | Stateful |
| LLM      | no        | no            | stream()        | Stateless |

No common interface. STT has 6 lifecycle methods, LLM has 1. Adding a new provider type requires understanding each interface separately.

## Proposed Architecture: Composable Stages

### Core Design: AsyncGenerator Composition

The dominant pattern for Bun/TS (from survey): stages as async generator functions.

```typescript
// Stage signature — pure async transform
type Stage<In, Out> = (
  input: AsyncIterable<In>,
  ctx: StageContext
) => AsyncGenerator<Out>;

// StageContext carries shared concerns without coupling
interface StageContext {
  signal: AbortSignal;
  config: StageConfig;
  emit: (event: PipelineEvent) => void;  // side-channel for status events
}
```

Compose via nesting: `ttsStage(aggStage(llmStage(transcript, ctx), ctx), ctx)`.

### Stage Breakdown

```
┌──────────────────────────────────────────────────────┐
│                    FlowManager                        │
│  Owns: connections, history, abort, session lifecycle │
├──────────────────────────────────────────────────────┤
│                                                      │
│  [AudioInput]                                        │
│       │  Uint8Array                                  │
│       ▼                                              │
│  [STTStage]  ← wraps STTProvider connect/send/final  │
│       │  TranscriptFrame (partial + final)            │
│       ▼                                              │
│  [TranscriptAccumulator]                             │
│       │  FinalTranscript (text string)               │
│       ▼                                              │
│  [LLMStage]  ← wraps LLMProvider.stream()            │
│       │  string (tokens)                             │
│       ▼                                              │
│  [SentenceAggregatorStage]  ← reuses existing logic  │
│       │  string (complete sentences)                 │
│       ▼                                              │
│  [TTSStage]  ← wraps TTSProvider.synthesize()        │
│       │  AudioFrame                                  │
│       ▼                                              │
│  [AudioOutput] → WS binary                          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### FlowManager — Central State Owner

```typescript
interface FlowManager {
  // Session lifecycle
  startSession(config: SessionConfig): Promise<void>;
  endSession(): Promise<void>;

  // Utterance lifecycle (maps to client utterance.start/end)
  handleUtteranceStart(): void;
  handleAudio(chunk: Uint8Array): void;
  handleUtteranceEnd(): AsyncGenerator<PipelineEvent>;

  // Interruption
  handleBargeIn(): void;

  // Status
  state(): PipelineState;
}
```

FlowManager owns:
- **Provider connections** — STT/TTS connect/disconnect lifecycle, keep-alive
- **Conversation history** — append after each turn completes
- **AbortControllers** — one per turn, rotated by BargeInController (reuse existing)
- **Audio buffer** — buffers audio if STT still connecting (currently in voice-session.ts)

Stages receive only what they need via `StageContext`. No stage knows about WS, history, or other stages.

### ContinuousSession vs Current VoiceSession

| Aspect | Current VoiceSession | Proposed ContinuousSession |
|--------|---------------------|---------------------------|
| Model | Push-to-talk: start/finish | Event-driven: utterance.start/end |
| STT lifecycle | Connect per recording | Stay connected across utterances |
| Partial transcripts | Discarded (`isFinal: true` only) | Relayed to client |
| State | 7 implicit closure vars | Explicit state machine |
| Turn ownership | Split with caller (AbortController) | Fully owned by FlowManager |

### Streaming Overlap as Stage Composition

Current `streaming-overlap.ts` achieves LLM→TTS parallelism by:
1. Background task feeds LLM tokens → SentenceAggregator
2. Foreground loop reads sentences from aggregator → synthesizes via TTS

This pattern maps naturally to async generator piping:

```typescript
async function* llmToAudioPipeline(
  transcript: string,
  ctx: StageContext
): AsyncGenerator<PipelineEvent> {
  const tokens = llmStage(toAsyncIter(transcript), ctx);
  const sentences = sentenceAggStage(tokens, ctx);
  const audio = ttsStage(sentences, ctx);

  // Text observation happens via ctx.emit() side-channel in llmStage
  for await (const frame of audio) {
    yield { type: 'audio.frame', frame };
  }
}
```

The LLM→SentenceAggregator→TTS overlap is preserved by pull-based backpressure: TTS pulls from SentenceAggregator which pulls from LLM. First sentence starts TTS while LLM continues producing tokens.

### Provider Adapter Pattern

Normalize all providers to stage interface:

```typescript
// STT adapter — wraps lifecycle into stage
function createSTTStage(provider: STTProvider, config: STTConfig): Stage<Uint8Array, TranscriptFrame> {
  return async function*(audio, ctx) {
    await provider.connect(config, ctx.signal);
    try {
      // Forward audio in background
      const consumer = consumeAsync(audio, chunk => provider.sendAudio(chunk));
      // Yield transcripts as they arrive
      for await (const event of provider.transcripts(ctx.signal)) {
        if (event.type === 'transcript') {
          yield { kind: 'data', type: 'transcript', text: event.text, isFinal: event.isFinal };
        }
      }
      await consumer;  // ensure all audio sent
    } finally {
      await provider.disconnect();
    }
  };
}
```

Swap Deepgram → Whisper: implement `STTProvider` interface, create adapter. Zero changes to pipeline wiring.

## Reuse Assessment

| Component | Reuse Strategy | Effort |
|-----------|---------------|--------|
| `sentence-aggregator.ts` | Wrap as stage (addToken→generator already works) | Minimal |
| `sentence-boundary.ts` | Direct reuse, no changes | None |
| `tts-processor.ts` | Already stateless, wrap as stage | Minimal |
| `barge-in-controller.ts` | Direct reuse in FlowManager | None |
| `audio-relay-processor.ts` | Pattern reference for STT stage adapter | Reference |
| `frame-queue.ts` | Use for priority output buffering | Optional |
| `pipeline.ts` / `processor.ts` | Replace with async generator composition | Superseded |
| `streaming-overlap.ts` | Pattern preserved, replaced by stage piping | Superseded |
| `voice-session.ts` | Replace with ContinuousSession + FlowManager | Replace |
| `voice-turn.ts` | Decompose into stage pipeline | Replace |
| `voice-handlers.ts` | Simplify to thin WS→FlowManager bridge | Rewrite |

## Key Design Decisions

### 1. Push at edges, pull internally
WebSocket callbacks are push-based. Convert to async iterable at the boundary (queue + generator), then everything internal is pull-based via async generators. Matches Pipecat architecture.

### 2. Side-channel for status events
Stages yield their primary output type. Status events (text.delta for UI, audio.start/done markers) go through `ctx.emit()`. This keeps stage signatures clean while preserving observability.

### 3. Per-turn stage instantiation
Create fresh stage pipeline per utterance/turn. No cross-turn state in stages. FlowManager owns cross-turn state (history, connections).

### 4. Explicit error boundaries
Each stage adapter wraps provider errors into typed `PipelineError`. FlowManager catches at stage boundaries and maps to user-visible error states. No error swallowing.

### 5. STT stays connected in continuous mode
STT WebSocket persists across utterances. `utterance.end` → `sttProvider.finalize()` → read transcripts → start LLM turn. Between utterances, STT is idle but connected. `flushTranscriptQueue()` clears stale events (existing pattern).

## Risks

1. **Backpressure mismatch**: LLM produces tokens faster than TTS consumes sentences. Current code handles this via SentenceAggregator buffering. In stage composition, the pull-based model handles it naturally — TTS pulls sentences at its own pace.

2. **Error propagation across generators**: If LLM errors mid-stream, the sentence aggregator must surface that error to TTS stage. Current code has this problem (error captured in variable, surfaced late). Stage composition with proper generator `throw()` semantics handles this more cleanly.

3. **Cancellation propagation depth**: `AbortSignal` must propagate through nested generators. Each `for await` loop must check `ctx.signal`. BargeInController already manages signal rotation — reuse as-is.

4. **STT connection lifecycle complexity**: Keeping STT connected across utterances adds reconnection handling. If STT WebSocket drops between utterances, FlowManager must reconnect transparently before next utterance starts.

5. **Stage overhead**: Each async generator adds a microtask hop. For 6 stages, that's ~6 microtask hops per frame. At audio frame rates (~100 frames/sec for 10ms chunks), this is negligible (<1ms total).
