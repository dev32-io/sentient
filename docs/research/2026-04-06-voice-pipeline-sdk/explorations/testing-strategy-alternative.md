# Explore: Testing Strategy Alternative — Contract-First Property-Based Testing

## Alternative Approach: `protocol-contract-generative`

Instead of bottom-up mock enhancement (the current approach), this alternative inverts the testing philosophy: **the protocol contract is the single source of truth that generates tests, mocks, and conformance suites automatically.**

## Core Idea

The current approach enhances mocks manually, adds layers, and builds a test harness state machine. The alternative:

1. **Protocol schemas generate everything** — Zod schemas in `shared/protocol/` already define all 22 message types. Use them to auto-generate: mock providers, property-based test cases, conformance suites, and sequence validators.
2. **Property-based testing over example-based** — Instead of writing explicit test cases for "happy path", "barge-in", "TTS failure after 2 chunks", use `fast-check` to generate random valid protocol sequences and verify invariants hold for ALL of them.
3. **Conformance suites over enhanced mocks** — Instead of making MockSTTProvider more capable, define a `STTProviderConformanceSuite` that any provider (real or mock) must pass. The mock is just the simplest conformance-passing implementation.
4. **Scenario DSL over imperative test code** — Declare test scenarios as data, not code. A scenario runner interprets them.

## Detailed Design

### Layer 1: Schema-Derived Test Infrastructure

The existing Zod schemas in `shared/protocol/src/messages.ts` define every message type. Build generators from them:

```typescript
// Auto-generate valid messages from Zod schemas
import { z } from "zod";
import * as fc from "fast-check";

function zodToArbitrary<T>(schema: z.ZodType<T>): fc.Arbitrary<T> {
  // Walk Zod schema tree, produce fast-check arbitrary
  // z.string() → fc.string()
  // z.number() → fc.double()
  // z.union([A, B]) → fc.oneof(arbA, arbB)
  // z.literal("x") → fc.constant("x")
  // z.object({...}) → fc.record({...})
}

// Generated from TranscriptPartialMessage schema:
const arbTranscriptPartial = zodToArbitrary(TranscriptPartialMessageSchema);
// Generated from all client→gateway schemas:
const arbClientMessage = fc.oneof(...clientMessageSchemas.map(zodToArbitrary));
// Generated from all gateway→client schemas:
const arbGatewayMessage = fc.oneof(...gatewayMessageSchemas.map(zodToArbitrary));
```

**Why this matters:** When a schema changes, test generators update automatically. No manual mock data updates. No "phantom interface" drift (Gap E from presence-gaps analysis).

### Layer 2: Protocol Invariant Properties

Instead of explicit test cases, define invariants that must hold for ALL valid protocol sequences:

```typescript
// Property: every audio.start is eventually followed by audio.end or error
fc.assert(fc.property(
  arbProtocolSequence({ maxLength: 50 }),
  (sequence) => {
    const result = validateProtocolSequence(sequence);
    return result.every(
      msg => msg.type !== "audio.start" || 
             sequence.slice(sequence.indexOf(msg)).some(
               m => m.type === "audio.end" || m.type === "error"
             )
    );
  }
));

// Property: state machine never reaches undefined state
fc.assert(fc.property(
  fc.array(arbEvent, { maxLength: 200 }),
  (events) => {
    let state = initialState;
    for (const event of events) {
      const next = transition(state, event);
      if (next === undefined) return false; // dead transition
      state = next;
    }
    return true;
  }
));

// Property: barge-in always terminates current response within N events
fc.assert(fc.property(
  arbPipelineScenarioWithBargeIn(),
  (scenario) => {
    const events = runPipeline(scenario);
    const bargeInIdx = events.findIndex(e => e.type === "barge_in");
    const responseEndIdx = events.findIndex((e, i) => 
      i > bargeInIdx && (e.type === "response.audio.done" || e.type === "error")
    );
    return responseEndIdx - bargeInIdx < MAX_BARGE_IN_LATENCY_EVENTS;
  }
));
```

**Key invariants to test:**
- Audio bracketing: every `audio.start` has a matching `audio.end` or error
- Transcript ordering: partials precede finals for the same utterance
- Response completeness: every `response.text.start` has a `response.text.done`
- State consistency: pipeline state is always valid after any event sequence
- Cleanup: every `connect` has a matching `disconnect` (no orphaned connections)
- Idempotency: duplicate events (double barge-in) don't corrupt state

### Layer 3: Provider Conformance Suites

Instead of enhancing mocks to be more realistic, define what ANY provider must do:

```typescript
// Conformance suite — runs against real OR mock providers
function sttConformanceSuite(createProvider: () => STTProvider) {
  describe("STT Provider Conformance", () => {
    it("yields at least one final transcript per audio segment", async () => {
      const provider = createProvider();
      await provider.connect(config, signal);
      provider.sendAudio(fixtures.shortUtterance);
      provider.finalize();
      const transcripts = await collectAll(provider.transcripts(signal));
      expect(transcripts.some(t => t.type === "transcript" && t.isFinal)).toBe(true);
      await provider.disconnect();
    });

    it("respects abort signal in transcripts generator", async () => {
      const provider = createProvider();
      await provider.connect(config, signal);
      const controller = new AbortController();
      const gen = provider.transcripts(controller.signal);
      controller.abort();
      // Should terminate, not hang
      const result = await withTimeout(gen.next(), 1000);
      expect(result.done).toBe(true);
      await provider.disconnect();
    });

    it("handles disconnect during active transcription", async () => {
      const provider = createProvider();
      await provider.connect(config, signal);
      provider.sendAudio(fixtures.shortUtterance);
      // Disconnect without finalize — provider must not hang or leak
      await provider.disconnect();
    });

    // ... 10-15 more conformance tests
  });
}

// Run against mock:
sttConformanceSuite(() => createMockSTTProvider());
// Run against real Deepgram (in CI with API key):
sttConformanceSuite(() => createDeepgramProvider());
```

**Why this matters:** The mock is proven to behave like the real provider because both pass the same conformance suite. When mock behavior diverges from real behavior, the conformance test for the real provider fails — you fix the mock, not the test.

### Layer 4: Scenario DSL

Declare test scenarios as structured data, not imperative code:

```typescript
// Scenario definition — pure data
const bargeInScenario: PipelineScenario = {
  name: "barge-in during TTS playback",
  setup: {
    stt: { transcripts: [partial("hello"), final("hello world"), utteranceEnd()] },
    llm: { tokens: ["I'm ", "doing ", "great, ", "thanks!"] },
    tts: { chunksPerSentence: 3, delayPerChunkMs: 50 },
  },
  timeline: [
    { at: 0, action: "send_audio", data: fixtures.shortUtterance },
    { at: "after:response.audio.frame:2", action: "barge_in" },
  ],
  assertions: [
    { type: "event_occurred", event: "barge_in.ack" },
    { type: "event_not_after", event: "response.audio.frame", after: "barge_in.ack", maxCount: 1 },
    { type: "state_at_end", expected: "listening" },
    { type: "no_orphaned_connections" },
  ],
};

// Scenario runner — interprets the declaration
async function runScenario(scenario: PipelineScenario): Promise<ScenarioResult> {
  const { pipeline, eventLog } = createTestPipeline(scenario.setup);
  
  for (const step of scenario.timeline) {
    if (typeof step.at === "number") {
      await delay(step.at - elapsed);
    } else {
      // "after:response.audio.frame:2" = wait until 2nd audio frame event
      await waitForEvent(eventLog, step.at);
    }
    await executeAction(pipeline, step.action, step.data);
  }
  
  await pipeline.drain();
  return evaluateAssertions(scenario.assertions, eventLog, pipeline);
}
```

**Why this matters:** Scenarios are composable, readable, and generate documentation. A new developer reads the scenario and understands what's being tested without parsing imperative test code. Scenarios can also be generated from properties (fast-check generates the timeline, assertions are invariants).

### Layer 5: Snapshot Regression (replacing record/replay)

Instead of recording real provider sessions, snapshot the protocol trace of each test run:

```typescript
it("happy path produces expected protocol trace", async () => {
  const trace = await runScenario(happyPathScenario);
  // First run: creates snapshot file
  // Subsequent runs: compares against snapshot
  expect(trace.protocolEvents).toMatchSnapshot();
});
```

When providers change behavior, snapshots break explicitly. Developer reviews diff and approves new snapshot — or fixes the regression.

**Simpler than record/replay because:**
- No recording infrastructure needed
- No base64 binary fixtures
- No timing replay logic
- Snapshot diffs are human-readable

## How This Addresses the Identified Gaps

| Gap | Current Approach Fix | This Approach Fix |
|-----|---------------------|-------------------|
| C2: Pipeline hang, no diagnostic | Stall timer + progress emissions | Property test catches hangs: timeout = invariant violation. Scenario runner has built-in timeout per step. |
| E: Interface drift | Remove `as unknown as` casts | Conformance suites: if mock and real both pass same suite, drift is impossible. Schema-derived generators auto-update. |
| F: No continuous mode testing | Enhanced mocks with async queue | Scenario DSL natively supports multi-utterance timelines. `timeline` array can span multiple turns. |
| A: Silent mock misconfiguration | Config validation | Conformance suite IS the validation — if mock config produces a provider that fails conformance, it's caught. |
| C1: Impossible failure scenarios | `failAfterChunks`, `simulateDisconnect` | Property tests generate failure scenarios automatically. `fc.oneof(normalBehavior, failureAfterN)` in arbitrary. |
| D1: No integration scaffolding | `createTestPipeline()` helper | Scenario runner IS the scaffolding. Pass scenario data, get results. |
| D3: Opaque event sequence errors | `assertEventSequence()` helper | Scenario assertions are declarative with named descriptions. Failures show "barge_in.ack not found after barge_in" not array diffs. |

## Comparison with Current Approach

| Dimension | mock-enhancement-layered (current) | protocol-contract-generative (this) |
|-----------|-------------------------------------|--------------------------------------|
| **Test creation effort** | Medium — write mocks + assertions per test | Low for common cases (DSL), high for DSL itself |
| **Coverage breadth** | Explicit — only covers cases you write | Generative — property tests explore edge cases you didn't think of |
| **Mock maintenance** | High — manually update mocks when interface changes | Low — schemas generate mocks, conformance suites catch drift |
| **Continuous mode support** | Async queue pattern (imperative, flexible) | Scenario timeline (declarative, less flexible for exotic cases) |
| **Developer onboarding** | Must understand mock APIs + harness state machine | Must understand scenario DSL + property concepts |
| **Upfront investment** | Low — enhance existing code | High — build schema→arbitrary bridge, scenario runner, conformance suites |
| **Long-term maintenance** | Each new feature needs new mock capabilities | Each new feature needs new schema (which you're writing anyway) + maybe new invariant |
| **Failure diagnosis** | Stall timer + stage indicators (rich) | Property test shrinking (finds minimal failing case) + scenario step-by-step trace |
| **Realistic timing** | Developer adds delays manually | Property tests can include timing as a parameter; conformance suite tests real provider timing |

## Key Trade-offs

### Advantages
1. **Coverage without effort** — Property-based tests find edge cases (double barge-in, empty transcripts, rapid reconnect) that explicit tests miss
2. **Self-updating** — Schema changes propagate to test generators automatically
3. **Conformance = confidence** — If mock passes same suite as real provider, mock is trustworthy
4. **Declarative scenarios** — Readable by non-testing-experts, double as documentation
5. **Minimal shrinking** — fast-check finds the smallest failing input, making debugging trivial

### Disadvantages
1. **Upfront cost** — Building `zodToArbitrary`, scenario runner, conformance suites is significant work
2. **Debugging property failures** — When a property test fails with a shrunk example, understanding WHY can require tracing through generated data
3. **DSL rigidity** — Scenario DSL works for anticipated patterns; novel test scenarios may need DSL extensions
4. **Less imperative control** — The async queue pattern in current approach gives fine-grained control over mock timing. Scenario timelines are coarser.
5. **fast-check dependency** — Adds a library dependency and requires team familiarity with property-based testing concepts

## Transferability to Real Codebase

**High transferability for:**
- Conformance suites — directly applicable to real providers, would catch Deepgram/Fish Audio behavioral regressions
- Protocol invariants — these are true of ANY correct implementation, so they transfer 1:1
- Schema-derived generators — `shared/protocol/src/messages.ts` already has all Zod schemas

**Medium transferability for:**
- Scenario DSL — useful but the pipeline structure must be stable first; DSL couples to pipeline shape
- Snapshot regression — simple to adopt but requires discipline around snapshot review

**Lower transferability for:**
- `zodToArbitrary` bridge — several libraries exist (`zod-fast-check`, `@effect/schema`) but none are production-grade for complex schemas with discriminated unions. May need custom work.

## Recommended Hybrid

The strongest approach combines elements:
- **From current:** Enhanced mocks with async queue (imperative control for exotic edge cases)
- **From alternative:** Conformance suites (confidence that mocks match reality), property-based invariant testing (coverage breadth), schema-derived generators (auto-updating)
- **Skip from alternative:** Full scenario DSL (too much upfront cost for uncertain payoff), snapshot regression (record/replay is more faithful to production)
