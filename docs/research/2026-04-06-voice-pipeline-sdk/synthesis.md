# Synthesis — Voice Pipeline SDK Redesign

*Living document. Updated after each Synthesize step.*

## Status: All explorations + PoCs complete, all topics scored

All 7 topics have deep explorations, alternative approaches, PoCs (state tables, test harnesses, consumer APIs), and scores. Architecture is validated and converging.

### Topic Status

| Topic | Status | Score | Primary Approach | Alternative Approach | Key Insight |
|-------|--------|-------|-----------------|---------------------|-------------|
| client-vad | scored | 37/60 | pluggable-detector-interface | gateway-delegated-vad | Ship energy-based default in AudioWorklet, Silero as opt-in. VAD feeds state machine only, never sends protocol messages directly. |
| sdk-state-machine | scored | 37/60 | pure-function-effects | statechart-reactive | 9 states, ~22 transitions. Pure `(state, event) → (state, effects[])`. Replaces 4 ad-hoc state machines (108 invalid combos). |
| sdk-gateway-contract | scored | 34/60 | utterance-lifecycle-contract | turn-envelope-protocol | `utterance.start/end` + `utteranceId/responseId` correlation. Activates dead `transcript.partial`. |
| gateway-pipeline | scored | 29/60 | async-generator-composition | frame-processor-pipeline | Stages as `(AsyncIterable<In>, StageContext) → AsyncGenerator<Out>`. FlowManager owns all cross-turn state. |
| codec-negotiation | scored | 22/60 | negotiation-protocol-layered | capability-profiles | Extend `session.start` with supported formats, add `session.ready`. Gateway owns all resampling. 3 existing bugs found. |
| testing-strategy | scored | 33/60 | mock-enhancement-layered-architecture | protocol-contract-generative | 5-layer testing. AsyncQueue for imperative mock emission. Property-based conformance suites as supplement. |
| error-ux | scored | 29/60 | error-classifier-recovery | reactive-error-stream-policies | 6 user-facing categories. Pure classifier + staged processing timer (2s/5s/15s/30s). |

### Score Breakdown

| Topic | PlugSimp | StateComp | UserPres | ExtSurf | BndClarity | TestIsol | Total |
|-------|----------|-----------|----------|---------|------------|----------|-------|
| client-vad | 7 | 5 | 6 | 8 | 8 | 3 | 37 |
| sdk-state-machine | 5 | 7 | 8 | 6 | 7 | 4 | 37 |
| sdk-gateway-contract | 6 | 4 | 7 | 7 | 8 | 2 | 34 |
| gateway-pipeline | 5 | 4 | 4 | 7 | 7 | 2 | 29 |
| codec-negotiation | 4 | 3 | 3 | 6 | 5 | 1 | 22 |
| testing-strategy | 7 | 4 | 3 | 7 | 6 | 6 | 33 |
| error-ux | 5 | 5 | 6 | 6 | 6 | 1 | 29 |

**Weakest dimensions across all topics:**
- **TestIsol** (avg 2.7): Most approaches lack concrete test isolation strategies. PoCs address this but scores reflect exploration-phase gaps.
- **StateComp** (avg 4.6): State composition complexity remains high, especially in gateway-pipeline and codec-negotiation.
- **UserPres** (avg 5.3): Several topics have silent gaps where user gets no feedback.

### PoC Results Summary

#### State Tables (formal transition models)
| PoC | States | Key Validation |
|-----|--------|---------------|
| client-vad-state-table | 11 states, 17 events | VAD/PTT/continuous modes unified. Exhaustive transitions with timeout guards. |
| sdk-state-machine (in consumer-api) | 9 states | Pure reducer. 20 tests, 57 assertions. Reconnection with retry budget. |
| sdk-gateway-contract-state-table | 10 states | Full session lifecycle: connect → auth → configure → stream → end. |
| gateway-pipeline-state-table | 11 states | Explicit LLM↔TTS overlap. 3-attempt reconnection. 154 tests. |
| codec-negotiation-state-table | 8 states | Negotiation → streaming → renegotiation lifecycle. |
| error-ux-state-table | 7 states | Error detection → notification → recovery → escalation. Max retries tracked. |
| testing-strategy-state-table | 10 states | Test orchestration: setup → execute → inject failure → assert → teardown. |

#### Test Harnesses (isolation testing)
| PoC | Key Coverage |
|-----|-------------|
| client-vad-test-harness | Synthetic audio: speech, coughs, noise, whispers, mid-sentence pauses. Multiple detector implementations. |
| sdk-state-machine-test-harness | All 9 states, timeout guards, VAD lifecycle, barge-in, reconnection backoff. |
| sdk-gateway-contract-test-harness | Zod-validated message schemas. Sequencing and state transition validation. |
| gateway-pipeline-test-harness | Happy path, multi-turn, barge-in, provider failures, timeout guards. Zero API keys. |
| codec-negotiation-test-harness | PCM16 roundtrips, resampling (48↔16↔44.1kHz), negotiation logic, end-to-end SDK↔Gateway. |
| error-ux-test-harness | All error sources/phases, recovery resolver, processing timer stages, state transitions. |

#### Consumer APIs (developer experience)
| PoC | Lines of Code | Key Proof |
|-----|--------------|-----------|
| sdk-state-machine-consumer-api | ~20 LOC | `VoiceStatus` + `onStatusChange()` drives entire UI. `canSpeak` hides complexity. |
| gateway-pipeline-consumer-api | ~30 LOC | `createVoicePipeline()` + iterate output events. All wiring hidden. |
| codec-negotiation-consumer-api | 12 LOC (client), 8 LOC (gateway) | `AudioSession.encode()/decode()` abstracts all codec details. |
| error-ux-consumer-api | 3 LOC | Create → classify → resolve. Pre-written friendly messages. |

### Alternative Approaches Assessment

| Topic | Alt Approach | Key Benefit | Key Risk | Viability |
|-------|-------------|------------|----------|-----------|
| client-vad | gateway-delegated-vad | Simpler SDK (6 states), single VAD impl | 50-200ms UX latency, always-streaming bandwidth | Yes, with hybrid hints |
| sdk-state-machine | statechart-reactive | Entry/exit safety, deduplication, visualization | 5-8KB bundle, learning curve | Yes as hybrid (hierarchical def + sync dispatch) |
| sdk-gateway-contract | turn-envelope-protocol | Simpler state (1 turnId), native replay, seq ordering | No multi-turn overlap, tool call limitation | Yes, improves TestIsol 2→7 |
| gateway-pipeline | frame-processor-pipeline | Reuses existing `pipeline.ts`/`processor.ts` code | Async producers don't fit sync push model | Yes as hybrid (push routing + async generators) |
| codec-negotiation | capability-profiles | 3-5 tested combos vs combinatorial explosion | Less flexible, profile proliferation | Yes, simpler protocol |
| testing-strategy | protocol-contract-generative | Schema-derived tests, self-updating mocks | High upfront cost, learning curve | High for conformance; medium for scenarios |
| error-ux | reactive-error-stream-policies | Temporal reasoning (3 errors in 30s), history correlation | Policy ordering bugs, complexity | Yes, better for voice UX |

### Presence Gap Analysis (Cross-Topic)

Deep-dive presence gap analysis was completed for gateway-pipeline, codec-negotiation, and testing-strategy. Key findings:

**Gateway Pipeline**: 10 identified gaps. Worst case: 7 seconds of pure silence before first feedback. Critical gaps: STT finalization can hang forever (no timeout), provider drop has no detection. P0: timeout guards on all reads, provider drop detection, emit `status.processing` immediately.

**Codec Negotiation**: Gaps are **corruption gaps, not silence gaps**. System works by accident (Deepgram auto-detects sample rate). No `session.start` handler exists despite schema definition. 48kHz played at 44.1kHz = 8.4% pitch shift. P0: implement negotiation handshake, add audio middleware layer.

**Testing Strategy**: Critical gaps: pipeline stall with 10s silent timeout, failure injection propagation unknown, assertion phase has no timeout. Most dangerous: `as unknown as` casts bypass type safety — tests pass against phantom interfaces. P0: remove casts, add config validation, add hang diagnostics.

### Boundary Leak Analysis (Codec Negotiation)

19 leak locations across 6 categories. Root cause: no audio middleware layer — audio bytes flow gateway→provider without format transformation. Changing STT provider requires 6+ file changes. Containment: insert audio middleware at gateway boundary as single transformation point.

### Architectural Convergence (Updated)

The post-scoring, post-PoC picture confirms and refines the pre-scoring convergence:

1. **State machine is the hub.** Validated by all 7 state table PoCs. Every topic's state model feeds into or is controlled by the SDK state machine. Consumer API PoC proves the 9-state model covers real scenarios.

2. **Pure functions everywhere.** All state tables, error classifier, codec negotiation logic, and recovery resolver are implemented as pure `(state, event) → (state, effects[])`. Maximizes testability — confirmed by test harness PoCs achieving zero-dependency isolation.

3. **AsyncGenerator as universal stage pattern.** Gateway pipeline PoC validates composable stages. Alternative (frame-processor) suggests hybrid: push-based routing for outer pipeline, async generators inside provider-wrapping processors.

4. **Gateway = opaque resampler + router.** Codec negotiation PoC + boundary leak analysis confirm: 19 leak locations need containment via audio middleware layer. Profile-based alternative simplifies the protocol surface.

5. **Contract drives everything.** Alternative (turn-envelope) suggests simplification from `utteranceId+responseId` to single `turnId`. Both approaches validated by test harness PoCs.

6. **Presence is non-negotiable.** Gap analysis found 7 seconds of potential silence, corruption gaps in codec, and test infrastructure that can hang forever. Every waiting state must have a timeout guard and user-visible indicator.

### Key Decisions (Post-PoC Validation)

| Decision | Status | Evidence |
|----------|--------|----------|
| Energy-based VAD as default | **Validated** | Test harness covers speech/noise/cough/whisper scenarios. RPi5 budget <0.1%. |
| Plain reducer over XState | **Validated** | Consumer API PoC: 20 LOC integration, 57 assertions pass. Statechart hybrid worth considering for >15 states. |
| Client-generated utteranceId | **Open** | Turn-envelope alternative proposes simpler `turnId`. Both work; turn-envelope improves testability. |
| Gateway-side resampling only | **Validated** | Codec test harness confirms resampling roundtrips. Profile alternative simplifies negotiation. |
| Per-turn pipeline instantiation | **Validated** | Pipeline test harness confirms zero cross-turn state leaks. |
| Option B (ignore) for double utterance | **Validated** | State table models this; acceptable for v1. |

### Recommended Hybrid Approaches

Based on PoC results, several topics benefit from combining primary + alternative:

1. **State Machine**: Primary (pure reducer) + statechart-style hierarchical definition for transition deduplication as state count grows past 12.
2. **Gateway Pipeline**: Primary (async generators) + frame-processor push routing for barge-in interrupt broadcasting.
3. **Testing Strategy**: Primary (enhanced mocks + 5-layer) + property-based conformance suites from alternative for protocol invariant coverage.
4. **Error UX**: Primary (classifier) for v1 simplicity + reactive policies for v2 when temporal reasoning (correlated errors) becomes important.
5. **Codec Negotiation**: Alternative (capability-profiles) for v1 protocol simplicity → primary (per-field negotiation) for v2 flexibility.

### Implementation Order (Confirmed)

Based on dependency analysis, PoC results, and score priorities:

1. **sdk-state-machine** (37/60) — foundational, everything depends on it
2. **sdk-gateway-contract** (34/60) — defines wire protocol
3. **gateway-pipeline** (29/60) — implements server side of contract
4. **client-vad** (37/60) + **codec-negotiation** (22/60) — independent, parallel
5. **error-ux** (29/60) — depends on state machine + contract
6. **testing-strategy** (33/60) — cross-cutting, evolves alongside all topics

### Existing Code Reuse Summary

| Component | Strategy | Notes |
|-----------|----------|-------|
| `sentence-aggregator.ts` | Wrap as async generator stage | Token→sentence boundary logic is solid |
| `sentence-boundary.ts` | Direct reuse, no changes | Punctuation/abbreviation detection |
| `tts-processor.ts` | Wrap as stage | Already stateless |
| `barge-in-controller.ts` | Direct reuse in FlowManager | AbortSignal rotation works |
| `audio-relay-processor.ts` | Pattern reference for STT stage | Closest to composable stage pattern |
| `capture-worklet.ts` | Insert VAD into existing pipeline | Float32→Int16 + batching, add RMS check |
| `playback-worklet.ts` | Reuse as-is | FIFO playback processor |
| `mock-stt-provider.ts` | Enhance with async queue | Add `emitEvent()`, `simulateDisconnect()` |
| `mock-tts-provider.ts` | Enhance with failure modes | Add `failAfterChunks`, `stallAfterChunks` |
| `audio-fixtures.ts` | Extend for multi-utterance | Add noise frames, continuous sequences |
| `pipeline.ts` / `processor.ts` | Potential hybrid reuse | Frame routing for barge-in broadcasting |
| `streaming-overlap.ts` | Pattern preserved, code replaced | Stage piping replaces callback-based overlap |
| `voice-session.ts` | Replace with ContinuousSession | 7 mutable closure vars → explicit state |
| `voice-turn.ts` | Decompose into stages | 13-field options bag → clean stage pipeline |
| `voice-handlers.ts` | Thin WS→FlowManager bridge | Monolith → adapter |

### What's Left

All exploration, scoring, and PoC work is complete. The architecture is validated with concrete code artifacts in `/workspace/poc/`. The next phase would be implementation in the real codebase, following the implementation order above and using PoC code as reference patterns.
