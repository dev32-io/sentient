# Integration Testing — Mock Provider Replay

## Current Test Infrastructure

### Existing Mocks (`shared/testing/src/`)

| File | Lines | Purpose |
|------|-------|---------|
| `mock-stt-provider.ts` | 114 | Pre-loads `TranscriptEvent[]`, yields in sequence. Tracks `audioReceived`, `connectCallCount`, `disconnectCallCount`. Supports `connectDelay`, `shouldFailConnect`. |
| `mock-tts-provider.ts` | 121 | Generates N chunks of M bytes. Tracks `synthesizeCalls`. Supports `shouldFailConnect`, `shouldFailSynthesize`, `delayPerChunkMs`. Respects `AbortSignal`. |
| `mock-provider.ts` | 28 | Generic `createMockStream<T>` — async generator from chunk array with latency, fail-after-N, or fail-at-end. |
| `mock-websocket.ts` | 43 | Minimal WS mock: `sentMessages`, `simulateMessage`, `simulateClose`. No event queue or async behavior. |
| `mock-session.ts` | 23 | Factory for `MockSession` with random IDs and AbortController. |
| `mock-auth.ts` | 50 | PASETO token creation, expiry simulation, mock claims. |
| `audio-fixtures.ts` | 62 | `createSilentPCM16Frame`, `createSineWavePCM16Frame`, `createUtteranceFrames`, Deepgram-format transcript/metadata JSON generators. |
| `index.ts` | 25 | Barrel re-export. |

### Existing Tests (50 files total)

**Gateway (~37 tests):**
- Pipeline: `voice-session.test.ts`, `voice-turn.test.ts`, `pipeline.test.ts`, `frame-queue.test.ts`, 3 barge-in tests
- Processors: `sentence-aggregator.test.ts` (+timers), `sentence-boundary.test.ts`, `streaming-overlap.test.ts` (+callbacks), `tts-processor.test.ts`, `audio-relay-processor.test.ts`
- Providers: 4 Deepgram tests (unit, streaming, connection, types), 5 Fish Audio tests (unit, protocol, connection, streaming, types)
- Server: `ws-server.test.ts`, `ws-server-voice.test.ts`

**Web (6 tests):** `types.test.ts`, `constants.test.ts`, `ring-buffer.test.ts`, `pcm-decoder.test.ts`, 2 hook tests

**Shared (7 tests):** `config/schema.test.ts`, `config/loader.test.ts`, `protocol/errors.test.ts`, `protocol/messages.test.ts`, `protocol/roles.test.ts`, `protocol/session.test.ts`, `protocol/frames.test.ts`

### Testing Stack
- **Framework:** Vitest (both gateway and web)
- **Coverage:** 80% statements, 75% branches enforced in CI
- **Test time:** <100ms per unit test
- **Web testing:** Testing Library + Preact
- **Mock source:** All from `@sentient/testing` package

---

## Gap Analysis

### Gap 1: MockSTTProvider is declarative-only (no imperative emission)

**Problem:** Events are pre-loaded in constructor as a flat array, yielded synchronously. The `transcripts()` generator immediately yields all events and exits. This makes it impossible to:
- Emit a partial transcript, wait, then emit a final
- Simulate STT dropping mid-stream
- Test timing-dependent behavior (e.g., partial transcripts arriving during LLM processing)
- Simulate continuous mode where STT stays connected across multiple utterances

**Current code (mock-stt-provider.ts:82-85):**
```typescript
async function* transcripts(_signal: AbortSignal): AsyncGenerator<TranscriptEvent> {
  for (const event of events) {
    yield event;
  }
}
```

**Impact:** Can't test the new continuous pipeline where STT stays connected and partials flow back to client in real-time. The redesigned pipeline relies on `transcript.partial` messages — these must be testable mid-stream.

**Fix approach — hybrid mock with imperative channel:**
```typescript
interface EnhancedMockSTTProvider extends MockSTTProvider {
  emitEvent(event: TranscriptEvent): void;
  simulateDisconnect(): void;
  simulateReconnect(): void;
  emittedEvents: TranscriptEvent[];
}
```
Internally use an async queue (push/pull pattern) instead of pre-loaded array. The `transcripts()` generator pulls from the queue, blocking until events arrive. Pre-loaded events get pushed into the queue at connect time (backward compat). `emitEvent()` pushes to the queue imperatively. `simulateDisconnect()` closes the queue with an error.

### Gap 2: No pipeline integration tests (end-to-end with real processors)

**Problem:** Tests exist for individual components (SentenceAggregator, StreamingOverlap, TTSProcessor) but nothing wires them together with mock providers to test the full turn lifecycle: `audio → STT → transcript → LLM → SentenceAggregator → StreamingOverlap → TTS → AudioFrames`.

**Impact:** Integration bugs hide at component boundaries:
- Does SentenceAggregator's flush timeout interact correctly with StreamingOverlap's sentence consumption?
- Does barge-in via AbortSignal propagate through the full chain?
- Are VoiceTurnEvents emitted in the right order (text.delta interleaved with audio.frame)?

**Fix approach:**
```typescript
// Wire real processors with mock providers
const pipeline = createTestPipeline({
  stt: createMockSTTProvider({ transcriptEvents: [...] }),
  llm: createMockLLMProvider(["Hello! ", "How ", "are ", "you?"]),
  tts: createMockTTSProvider({ chunkCount: 2 }),
});

const events = await collectAllEvents(pipeline.runTurn(audioFixtures));
assertEventSequence(events, [
  "transcript.partial", "transcript.final",
  "response.text.delta", // multiple
  "response.audio.start",
  "response.audio.frame", // multiple
  "response.audio.done",
  "response.text.done",
]);
```

### Gap 3: No WebSocket contract tests (full round-trip)

**Problem:** `ws-server.test.ts` and `ws-server-voice.test.ts` exist but they test message routing logic, not the full round-trip protocol. No test sends binary audio frames through a real WS connection and asserts the complete response sequence.

**Impact:** Protocol regressions (wrong message order, missing fields, Zod validation mismatches between client and gateway) only surface in manual testing.

**Fix approach — real Bun server on random port:**
```typescript
const server = createGatewayServer({
  port: 0, // random
  sttProvider: mockSTT,
  llmProvider: mockLLM,
  ttsProvider: mockTTS,
  // ...
});

const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
// Auth → session.start → audio.start → binary frames → audio.end
// Assert: auth.ok → transcript.partial → transcript.final → response.text.delta* → response.audio.start → binary* → response.audio.done → response.text.done
```

Key assertions:
- Every gateway→client message validates against its Zod schema
- Binary frames arrive between `response.audio.start` and `response.audio.done`
- `barge_in` during response causes immediate `barge_in.ack` + response truncation
- Auth failure returns proper close code (4001)

### Gap 4: No record/replay pattern for provider sessions

**Problem:** No way to capture a real Deepgram/Fish Audio/OpenRouter session and replay it deterministically. Tests either use synthetic mocks (potentially diverging from reality) or require live API keys.

**Impact:** Mock behavior might not match real provider behavior (timing, event ordering, edge cases). Real provider sessions reveal behaviors hard to anticipate (e.g., Deepgram sometimes sends empty `transcript` events, Fish Audio sends variable chunk sizes).

**Fix approach — fixture-based replay provider:**
```typescript
// Recording format
interface ProviderFixture {
  provider: "deepgram" | "fish-audio" | "openrouter";
  recordedAt: string;
  events: Array<{
    timestamp: number;  // ms from start
    direction: "in" | "out";
    type: "binary" | "json";
    data: string;  // base64 for binary, JSON string for json
  }>;
}

// Replay provider
function createReplaySTTProvider(fixture: ProviderFixture): STTProvider {
  // On connect: start replay timer
  // On sendAudio: validate against fixture's "in" events (optional)
  // transcripts(): yield fixture's "out" events at recorded timestamps
}
```

One-time recording cost: ~$0.01 per session. Fixtures checked into repo as JSON.

### Gap 5: No edge case/failure mode tests

**Problem:** No tests for:
- STT connection drop mid-audio-stream
- TTS synthesis failure after partial audio sent
- WebSocket close during `runVoiceTurn`
- Double barge-in (two `barge_in` messages in rapid succession)
- Auth token expiring mid-session
- LLM stream error after partial response

**Impact:** These are the scenarios most likely to cause production issues (leaked promises, orphaned connections, client stuck in wrong state).

**Fix approach — imperatively triggered failures:**
```typescript
// STT drop mid-stream
it("handles STT disconnect during audio", async () => {
  const stt = createEnhancedMockSTTProvider();
  stt.emitEvent({ type: "transcript", text: "hel", isFinal: false, ... });
  stt.simulateDisconnect(); // closes transcript generator with error
  // Assert: error event sent to client, session recoverable
});

// TTS failure mid-synthesis
it("handles TTS failure after partial audio", async () => {
  const tts = createMockTTSProvider({ 
    shouldFailSynthesize: true, 
    failAfterChunks: 2 
  });
  // Assert: partial audio frames sent, then error, clean shutdown
});

// Double barge-in
it("handles rapid double barge-in idempotently", async () => {
  // Send two barge_in messages within 10ms
  // Assert: one barge_in.ack, no double-abort crash
});
```

### Gap 6: No formal state machine tests

**Problem:** No state machine exists yet (it's a design goal), so no tests. But the testing strategy must account for state machine testing from the start.

**Impact:** The state machine is the central coordination point. Without exhaustive tests, invalid transitions will cause silent corruption.

**Fix approach — three-layer testing:**

1. **Exhaustive transition table:** Every (state, event) pair has a defined outcome. Test all N×M combinations. For 7 states × ~12 events = 84 assertions, runs in <10ms.

2. **Property-based testing with fast-check:**
```typescript
import * as fc from "fast-check";

fc.assert(fc.property(
  fc.array(fc.oneof(...allEventArbitraries), { maxLength: 100 }),
  (events) => {
    let state = initialState;
    for (const event of events) {
      state = transition(state, event);
      // Invariants: state is always a valid State, no undefined
    }
    return isValidState(state);
  }
));
```

3. **BFS reachability:** Starting from `inactive`, BFS over all transitions. Assert every state is reachable. Assert no state is a dead-end (except terminal states).

### Gap 7: MockTTSProvider lacks mid-synthesis failure control

**Problem:** `shouldFailSynthesize` fails at start. Can't simulate failure after N chunks (unlike `mock-provider.ts` which has `failAfterChunks`). No way to simulate TTS stalling (producing no chunks for extended time).

**Fix approach:** Add `failAfterChunks` and `stallAfterChunks` to `MockTTSBehavior`:
```typescript
interface MockTTSBehavior {
  // existing...
  failAfterChunks?: number;     // throw after N successful chunks
  stallAfterChunks?: number;    // stop producing after N chunks (never resolve)
  stallDurationMs?: number;     // how long to stall before resuming (or timing out)
}
```

---

## Proposed Testing Architecture

### Layer 1: Unit Tests (existing, enhance)

Each component tested in isolation. Mock all dependencies.
- `sentence-aggregator.test.ts` — token sequences → sentence outputs
- `streaming-overlap.test.ts` — sentences → interleaved audio frames
- `tts-processor.test.ts` — text → AudioFrame sequences
- `frame-queue.test.ts` — priority ordering, system frame preemption
- State machine: exhaustive transition table

**Enhancement needed:** Add failure-mode test cases to each component test.

### Layer 2: Pipeline Integration Tests (new)

Real processors wired with mock providers. No network, no external services.

**Test matrix:**
| Scenario | STT | LLM | TTS | Validates |
|----------|-----|-----|-----|-----------|
| Happy path | 1 final transcript | 2 sentences | 3 chunks each | Full event sequence, timing |
| Partial transcripts | 3 partials + 1 final | — | — | Client receives partials |
| Barge-in during response | — | 5 slow sentences | 2 chunks each | AbortSignal propagation, cleanup |
| LLM error mid-stream | — | fail after 3 tokens | — | Error event, partial text.done |
| TTS error mid-synthesis | — | 1 sentence | fail after 1 chunk | Partial audio, error, text fallback |
| Multi-turn | 2 transcripts sequentially | 2 responses | — | History accumulation, state reset |

### Layer 3: WebSocket Contract Tests (new)

Real Bun server + mock providers + real WS client. Validates the over-the-wire protocol.

**Test cases:**
- Full voice turn: auth → session.start → audio.start → binary → audio.end → full response
- Auth failure: invalid token → close 4001
- Auth timeout: no auth within timeout → close 4001
- Barge-in: interrupt mid-response
- Session expiry: token expires during session
- Binary/JSON multiplexing: audio frames arrive as binary, control as JSON
- Message ordering: responses always bracket audio with start/done

### Layer 4: Record/Replay Tests (new)

Captured real provider sessions replayed deterministically. Validates that mock behavior approximates real provider behavior.

**Fixture format:**
```json
{
  "provider": "deepgram",
  "recordedAt": "2025-01-15T10:00:00Z",
  "input": { "text": "hello world", "duration_ms": 1200 },
  "events": [
    { "ts": 0, "dir": "out", "type": "json", "data": "{\"type\":\"Metadata\",...}" },
    { "ts": 200, "dir": "out", "type": "json", "data": "{\"type\":\"Results\",\"is_final\":false,...}" },
    { "ts": 800, "dir": "out", "type": "json", "data": "{\"type\":\"Results\",\"is_final\":true,...}" },
    { "ts": 1100, "dir": "out", "type": "json", "data": "{\"type\":\"UtteranceEnd\"}" }
  ]
}
```

### Layer 5: SDK Client Tests (new, for post-redesign)

Real VoiceClient SDK + mock transport + mock audio adapters. Validates the SDK's black-box API.

**Test cases:**
- `voiceClient.start()` → state transitions to `listening`
- Audio detected → `user-speaking` state + `utterance.start` sent
- Silence detected → `processing` state + `utterance.end` sent
- Response received → `assistant-speaking` state + audio plays
- User speaks during response → barge-in triggered
- Connection lost → `reconnecting` state → auto-recover or error
- All states emit user-visible signal within 400ms

---

## Mock Enhancement Design

### Async Queue Primitive (shared building block)

Both enhanced STT and TTS mocks need an async pull-based queue:

```typescript
interface AsyncQueue<T> {
  push(item: T): void;
  close(): void;
  error(err: Error): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  // Internal: array of items + array of waiting resolvers
  // push(): if resolver waiting, resolve immediately; else buffer
  // close(): resolve all waiting with done:true
  // error(): reject all waiting with error
  // iterate(): pull from buffer or wait for push
}
```

This is the core primitive that enables imperative event emission. The enhanced MockSTTProvider wraps this queue.

### MockLLMProvider (missing entirely)

No mock LLM provider exists in `shared/testing/`. Tests currently use `createMockStream<string>()` from `mock-provider.ts`. Need a proper mock:

```typescript
interface MockLLMBehavior {
  tokens?: string[];
  delayPerTokenMs?: number;
  shouldFail?: boolean;
  failAfterTokens?: number;
  errorMessage?: string;
}

interface MockLLMProvider extends LLMProvider {
  streamCalls: LLMStreamOptions[];
  callCount: number;
}
```

---

## Key Design Decisions

### 1. Imperative > Declarative for continuous mode

The push-to-talk model fits declarative mocks: pre-load events, run turn, check output. Continuous mode requires imperative control: emit partial, wait for client to relay, emit final, trigger next turn. The async queue pattern bridges both — pre-loaded events push into the queue at connect, imperative events push later.

### 2. Test the contract, not the implementation

WS contract tests should validate message schemas and ordering, not internal pipeline state. If the gateway sends `transcript.partial` followed by `transcript.final` with correct Zod-valid payloads in the right order, the test passes regardless of how the gateway internally processed it.

### 3. No dependency on test execution order

Each test creates its own server, providers, and connections. No shared state between tests. Use `beforeEach`/`afterEach` for cleanup (close servers, abort controllers).

### 4. Timing-sensitive tests use fake timers

Tests that depend on timeouts (sentence aggregator flush, connection timeout, retry backoff) use `vi.useFakeTimers()`. Tests that depend on async ordering use deterministic async generators, not real delays.

### 5. Edge case tests prove cleanup, not just error surfacing

A test for "STT drops mid-stream" must assert:
- Error event sent to client (user visibility)
- STT connection closed cleanly (no orphan)
- Turn aborted (no leaked async work)
- Pipeline ready for next turn (state reset)

---

## Codebase Reuse

- **Enhance, don't replace** existing mocks — backward compat via pre-loaded events
- **Extend `audio-fixtures.ts`** with multi-utterance sequences, noise frames
- **Reuse `createMockStream<T>`** from `mock-provider.ts` for LLM mock
- **Reuse Deepgram fixture generators** (`createDeepgramTranscriptResponse` etc.) for replay fixtures
- **Vitest + Bun** as test runner — no new tooling needed
- **`@sentient/testing`** package remains the single source of test utilities
