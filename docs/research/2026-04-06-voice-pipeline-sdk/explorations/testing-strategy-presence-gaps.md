# Explore: Testing Strategy Presence Gaps

## Objective

Map the complete timeline from every **developer action** to every **system response** during testing of the voice pipeline, identifying every silent gap where the developer receives no feedback about what's happening. The "user" here is a developer writing and running tests — not the voice app end-user.

## Methodology

Traced the actual test developer experience through: (1) existing test files in the codebase (`voice-session.test.ts`, `voice-turn.test.ts`, etc.), (2) existing mock providers (`shared/testing/src/`), (3) the test framework (Vitest + Bun), and (4) the proposed test harness architecture from the rethink analysis. Categorized gaps by duration, detectability, and severity.

## Complete Timeline: Developer Testing Experience

### Segment A: Mock Provider Setup

```
[Developer writes a test]
  │
  ├─ T0: Creates mock providers with behavior config
  │     → createMockSTTProvider({ transcriptEvents: [...] })
  │     → createMockTTSProvider({ chunkCount: 3 })
  │     → Feedback: NONE — mocks created synchronously, no validation
  │     ⏱ ~0ms
  │
  ├─ T1: Passes invalid config to mock
  │     e.g., shouldFailConnect + transcriptEvents (contradictory)
  │     e.g., failAfterChunks > chunkCount (will never trigger)
  │     → Feedback: NOTHING — no config validation
  │     → Fails silently at runtime with confusing behavior
  │
  ├─ T2: Creates local ad-hoc mocks (common pattern)
  │     → voice-session.test.ts defines mockSTT() and mockTTS() locally
  │     → voice-turn.test.ts defines mockLLM(), mockTTS(), mockContext() locally
  │     → These are NOT @sentient/testing mocks — different interface, no tracking
  │     → Feedback: NONE — developer doesn't know they have TWO mock systems
  │
  └─ T3: Wires mocks into system under test
       → createVoiceSession({ sttProvider: stt, ... })
       → Feedback: NONE — no type error if mock interface drifts from real interface
       → Uses `as unknown as STTProvider` casts (voice-session.test.ts:23)
```

**GAP A: Silent mock misconfiguration** — Developer can create contradictory or impossible mock configs with zero validation feedback. Contradictory configs (e.g., `shouldFailConnect: true` with `connectDelay: 0`) or configs where failure conditions can never trigger (e.g., `failAfterChunks: 10` when `chunkCount: 3`) silently produce tests that pass for the wrong reason.

**GAP A2: Dual mock systems** — The codebase has two parallel mock systems: `@sentient/testing` mocks (with tracking, behavior config) and ad-hoc per-test mocks (voice-session.test.ts:6-38, voice-turn.test.ts:7-38). Neither warns about the other. A developer might use the wrong one, get no tracking, and not understand why assertions about `connectCallCount` fail.

### Segment B: Test Execution — Happy Path

```
[Developer runs `bun run test`]
  │
  ├─ T4: Vitest discovers and starts test
  │     → Feedback: Vitest shows test name running
  │     ⏱ ~0ms
  │
  ├─ T5: Mock provider connect() called
  │     → If connectDelay set: test blocks on setTimeout
  │     → Feedback: NOTHING from mock — just time passing
  │     → Vitest: no per-step progress, just "running..."
  │     ⏱ 0-N ms (configurable delay)
  │
  ├─ T6: Mock STT transcripts() called
  │     → All events yielded immediately (mock-stt-provider.ts:82-85)
  │     → No timing simulation — events dump synchronously
  │     → Feedback: NONE — developer can't see that events were emitted
  │     ⏱ ~0ms (unrealistically fast)
  │
  ├─ T7: Mock TTS synthesize() called
  │     → Chunks yielded with optional delay (mock-tts-provider.ts:81-95)
  │     → Feedback: NONE — only tracked in synthesizeCalls array
  │     ⏱ 0-N ms per chunk
  │
  ├─ T8: Pipeline produces output events
  │     → voice-turn.test.ts collects events in array (line 43)
  │     → Feedback: NONE until all events collected and assertions run
  │     ⏱ varies
  │
  └─ T9: Assertions run
       → expect(textDeltas).toEqual([...])
       → Feedback: PASS or FAIL from Vitest
       ⏱ ~0ms
```

**GAP B: No pipeline progress during execution** — Between test start (T4) and assertion result (T9), the developer sees only "running..." from Vitest. For fast unit tests (<100ms), this is acceptable. But for integration tests with delays, there's no indication of which stage the pipeline is in (STT → LLM → TTS → output).

**GAP B2: Mock timing unrealism** — `transcripts()` dumps all events synchronously. Real STT produces partials over 200-500ms with interleaving. A test passes with synchronous dump but fails with realistic timing because the pipeline code path is different. Developer gets no warning that their mock timing is unrealistic.

### Segment C: Test Execution — Failure Path

```
[Developer runs a test expecting a failure scenario]
  │
  ├─ T10: shouldFailConnect = true on mock STT
  │      → connect() throws immediately
  │      → Feedback: error thrown — good, but...
  │      → No indication of WHICH provider failed if multiple are set up
  │      ⏱ ~0ms
  │
  ├─ T11: shouldFailSynthesize = true on mock TTS
  │      → synthesize() throws at START — no partial-failure simulation
  │      → Feedback: error thrown, but...
  │      → Developer can't test "TTS fails after 2 chunks"
  │      → MockTTSProvider has no failAfterChunks (unlike mock-provider.ts)
  │      ⏱ ~0ms
  │
  ├─ T12: STT drops mid-stream (desired test)
  │      → IMPOSSIBLE with current MockSTTProvider
  │      → transcripts() is a static generator — can't inject failure mid-iteration
  │      → Developer must write a custom generator from scratch
  │      → Feedback: NONE — no error saying "this mock can't do that"
  │
  ├─ T13: Pipeline hangs (bug in system under test)
  │      → for await loop in test body blocks forever
  │      → Feedback: NOTHING until Vitest's global test timeout (5s default)
  │      → Developer stares at "running..." for 5 seconds
  │      → When timeout hits: generic "Timed out" with NO indication of where
  │      ⏱ 5000ms of silence
  │
  └─ T14: AbortSignal test (barge-in)
       → controller.abort() called mid-iteration (voice-turn.test.ts:76-80)
       → Generators should terminate
       → Feedback: if generator doesn't respect signal, test hangs (→ T13)
       → No abort propagation tracking — developer can't see abort path
```

**GAP C1: Impossible failure scenarios** — Developer wants to test "STT drops mid-stream" or "TTS fails after 2 chunks" but the mock APIs don't support it. No error message, no documentation, no suggestion — just silent impossibility. Developer must discover the limitation by reading mock source code.

**GAP C2: Hang diagnosis** — When a pipeline test hangs (T13), the developer gets only a generic timeout after 5 seconds. No indication of which stage hung, what the last event was, or whether any progress was made. The 5s timeout is the ONLY feedback for a hung test, and it carries zero diagnostic information.

**GAP C3: Missing mock capabilities without errors** — MockTTSProvider supports `shouldFailSynthesize` (fail at start) but not `failAfterChunks` (fail mid-stream). The generic `createMockStream` in `mock-provider.ts` DOES support `failAfterChunks`, but MockTTSProvider doesn't use it. Developer has to know about this discrepancy by reading two separate files.

### Segment D: Multi-Component Integration Testing

```
[Developer wants to test full pipeline: STT → LLM → Aggregator → TTS]
  │
  ├─ T15: No integration test helpers exist
  │      → Developer must manually wire all components
  │      → voice-turn.test.ts does this partially (LLM → Aggregator → TTS)
  │      → But no helper to wire STT → transcript → LLM chain
  │      → Feedback: NONE — no "createTestPipeline" helper, no documentation
  │
  ├─ T16: Developer manually wires pipeline
  │      → Creates mock STT, LLM, TTS
  │      → Creates real SentenceAggregator + StreamingOverlap
  │      → Wires together with custom code
  │      → Feedback: NONE — only compile errors if types mismatch
  │
  ├─ T17: Pipeline runs with mixed real/mock components
  │      → Mock events dump synchronously through real processors
  │      → Real SentenceAggregator has 2s flush timeout
  │      → If mock LLM produces tokens without sentence boundaries:
  │        → 2s hang waiting for flush timeout
  │        → Feedback: NOTHING for 2 seconds
  │      ⏱ 0-2000ms silence from flush timer
  │
  └─ T18: Event ordering assertion
       → Developer collects events, checks order
       → Feedback: if wrong order, assertion error shows full arrays
       → BUT: no structured diff showing which event is out of place
       → Just: "Expected [...100 events...] to equal [...100 events...]"
```

**GAP D1: No integration test scaffolding** — Developer must reinvent pipeline wiring for every integration test. No `createTestPipeline()` helper, no documented pattern. Each test file (voice-session.test.ts, voice-turn.test.ts) creates its own incompatible mock setup.

**GAP D2: Flush timer surprise** — When mock tokens don't contain sentence-ending punctuation, the SentenceAggregator's 2s flush timer causes a silent 2s hang in what the developer expected to be an instant test. No warning, no indication — just a test that takes 2+ seconds instead of <100ms.

**GAP D3: Opaque event sequence errors** — When event ordering is wrong, Vitest dumps two large arrays. For a pipeline producing 50+ events, finding the first mismatch in a wall of JSON is painful. No helper to show a structured diff like "expected audio.start at position 5, got text.delta".

### Segment E: Provider Contract Drift

```
[Provider interface changes in gateway code]
  │
  ├─ T19: Real STTProvider interface gets new method
  │      → e.g., `setEndpointing(ms: number)` added
  │      → shared/testing MockSTTProvider: NOT updated
  │      → Feedback: NONE — tests still pass because mocks use `as unknown as`
  │      → voice-session.test.ts:23 literally casts away type safety
  │
  ├─ T20: Real provider behavior changes
  │      → e.g., Deepgram starts sending empty transcript events
  │      → Mocks don't replicate this behavior
  │      → Feedback: NONE — tests pass, production breaks
  │
  └─ T21: Protocol message schema changes
       → shared/protocol adds new field to transcript.final
       → Tests using mock data don't include the field
       → Feedback: Zod validation may catch at runtime, or may not
       → If field is optional: NOTHING — silent schema drift
```

**GAP E: Interface and behavior drift** — The `as unknown as` casts in test files (voice-session.test.ts:23, voice-turn.test.ts) bypass TypeScript's type checking entirely. When the real provider interface changes, mock tests continue to pass against the old interface. Developer gets zero feedback that their mocks are now testing a phantom API.

### Segment F: Continuous Mode Testing (Future)

```
[Developer wants to test continuous voice mode]
  │
  ├─ T22: Needs STT that stays connected across utterances
  │      → MockSTTProvider: transcripts() yields all events and exits
  │      → Can't simulate: partial → final → pause → partial → final
  │      → Feedback: NONE — developer discovers limitation mid-test
  │
  ├─ T23: Needs to inject events imperatively during test
  │      → "Emit partial, wait for client relay, then emit final"
  │      → MockSTTProvider has no emitEvent() method
  │      → Feedback: NONE — must write custom async generator
  │
  └─ T24: Needs to test timing-dependent behavior
       → "Partial arrives DURING LLM processing"
       → No way to coordinate mock timing across providers
       → Feedback: NONE — no timing coordination primitives
```

**GAP F: Complete absence of continuous mode testing support** — The entire mock infrastructure is designed for push-to-talk (pre-load events → run turn → check output). Continuous mode requires imperative event injection, cross-provider timing coordination, and long-lived mock connections. None of this exists, and there's no error or documentation telling the developer.

## Gap Severity Matrix

| # | Gap | Segment | Duration | Frequency | Severity |
|---|-----|---------|----------|-----------|----------|
| C2 | Pipeline hang — no diagnostic info | C | 5000ms (timeout) | When bugs exist | **Critical** |
| E | Interface/behavior drift — mocks test phantom API | E | Permanent | Every refactor | **Critical** |
| F | No continuous mode testing support | F | Permanent | Every new test | **Critical** |
| A | Silent mock misconfiguration | A | Permanent (wrong results) | Common | **High** |
| C1 | Impossible failure scenarios | C | N/A | When testing failures | **High** |
| D2 | Flush timer 2s surprise in integration tests | D | 2000ms | With non-punctuated mock data | **High** |
| A2 | Dual mock systems, no guidance | A | Permanent (confusion) | Onboarding | **Medium** |
| B2 | Mock timing unrealism | B | N/A (wrong model) | Every mock test | **Medium** |
| D1 | No integration test scaffolding | D | N/A (productivity) | Every integration test | **Medium** |
| D3 | Opaque event sequence errors | D | N/A (debugging time) | On assertion failure | **Medium** |
| C3 | Missing capabilities without errors | C | N/A (confusion) | When testing edge cases | **Low** |
| B | No per-stage progress in test output | B | 0-100ms | Every test run | **Low** |

## Worst-Case Developer Experience

A developer trying to write their first continuous mode integration test:

```
1. Creates MockSTTProvider with transcriptEvents    → No validation (Gap A)
2. Realizes they need imperative emission            → Discovers impossibility by reading source (Gap F)
3. Writes custom async generator mock                → No helpers, no pattern (Gap D1)
4. Wires mock into pipeline manually                 → No createTestPipeline (Gap D1)
5. Mock tokens lack sentence punctuation             → 2s silent hang from flush timer (Gap D2)
6. Adds punctuation, pipeline runs                   → Events dump synchronously (Gap B2)
7. Tests pass but production fails                   → Mock timing doesn't match real timing (Gap B2)
8. Adds timing delays to mock                        → Pipeline hangs on a bug
9. Stares at "running..." for 5 seconds              → Generic timeout, no stage info (Gap C2)
10. Fixes bug, wants to test TTS failure mid-stream  → Impossible with MockTTSProvider (Gap C1)
11. Real provider interface changes next sprint       → Tests still pass, wrong interface (Gap E)
```

**Total friction points: 11.** Developer gets helpful feedback at exactly **zero** of them.

## Recommendations Prioritized by Impact

### P0 — Critical (Prevent wrong test results)

1. **Remove `as unknown as` casts** — Make mocks structurally match real provider interfaces. Use `satisfies` instead. When interface drifts, tests should fail to compile.
2. **Add pipeline hang diagnostics** — When a for-await loop exceeds 1s, emit a warning showing the last yielded event and which generator is blocked.
3. **Add mock config validation** — `createMockSTTProvider()` should throw if config is contradictory (e.g., `failAfterChunks > transcriptEvents.length`).

### P1 — High (Enable continuous mode testing)

4. **Imperative mock STT** — Add `emitEvent()` / `simulateDisconnect()` to MockSTTProvider via async queue pattern (detailed in testing-strategy.md Gap 1).
5. **Add `failAfterChunks` to MockTTSProvider** — Align with `createMockStream` capabilities.
6. **Create `createTestPipeline()` helper** — Single function that wires mock providers with real processors, returning event collector.

### P2 — Medium (Improve developer experience)

7. **Consolidate dual mock systems** — Either remove ad-hoc mocks from test files and use `@sentient/testing`, or document when to use which.
8. **Add `assertEventSequence()` helper** — Structured diff showing first mismatch in event ordering, not a wall of JSON.
9. **Document flush timer behavior** — Warn developers that mock tokens without punctuation trigger 2s flush delays.

### P3 — Low (Polish)

10. **Add timing simulation mode to mocks** — Optional realistic timing that mirrors actual provider latency patterns.
11. **Record/replay fixtures** — Capture real provider sessions for deterministic replay (detailed in testing-strategy.md Gap 4).
12. **Per-stage progress in test harness output** — Emit stage transitions for long-running integration tests.

## Key Finding

The most dangerous gap is not a timeout or a hang — it's **silent correctness failure** (Gap E). Tests that pass against a phantom interface give false confidence. The `as unknown as` casts in voice-session.test.ts and voice-turn.test.ts are type safety escape hatches that make provider contract drift invisible. This is the one gap that can cause production incidents with zero test-time warning.
