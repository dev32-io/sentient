# Pipeline Sub-Decision: Test Strategy

## Parent Decision Area
`pipeline-architecture` — this is a sub-decision extracted during decomposition.

## Decision Area
How to test the frame-based pipeline — specifically barge-in propagation, UninterruptibleFrame survival, streaming overlap timing, sentence boundary edge cases, and queue drain behavior. These are behaviors that are non-trivial to test but critical to correctness.

## Key Questions

1. **Unit test boundaries**: What's a "unit" in a frame pipeline — individual processors, or processor pairs?
2. **Barge-in testing**: How to verify that InterruptionFrame drains queues, cancels tasks, and preserves UninterruptibleFrames?
3. **Timing/ordering tests**: How to assert that TTS starts before LLM finishes (streaming overlap) without flaky timing assertions?
4. **Mock providers**: Should tests use mock STT/LLM/TTS or in-process fakes that simulate streaming behavior?
5. **Sentence aggregator edge cases**: How to cover abbreviations, ellipsis, code blocks, numbered lists?
6. **Integration scope**: What's the minimal end-to-end test that proves the pipeline works?

## Approaches Evaluated

### A. Frame-Level Unit Tests with Mock Queues

Test each processor in isolation: feed frames in, assert frames out.

**How it works:**
- Each processor is instantiated standalone (not linked into a pipeline)
- Replace `push_downstream()` with a collector that captures emitted frames
- Feed specific frame sequences via `process_frame()` and assert outputs
- Test barge-in by calling `handle_interruption()` directly on a pre-loaded queue
- Test UninterruptibleFrame survival by verifying it remains after queue drain

**Example test pattern:**
```python
async def test_sentence_aggregator_basic():
    agg = SentenceAggregator()
    output = []
    agg.push_downstream = lambda f: output.append(f) or asyncio.sleep(0)
    
    for token in ["The ", "weather ", "is ", "sunny. "]:
        await agg.process_frame(LLMResponseFrame(text=token), DOWNSTREAM)
    
    assert len(output) == 1
    assert output[0].text == "The weather is sunny."
```

**Coverage:**
- Sentence aggregator boundary rules, abbreviation handling, decimal protection
- Queue drain behavior — SystemFrames survive, DataFrames dropped
- UninterruptibleFrame preservation
- Individual processor error handling

**Pros:**
- Fast — no async scheduling, no timing dependencies, runs in <10ms
- Deterministic — no race conditions, no flaky tests
- Easy to write — standard pytest patterns, no infrastructure
- Fine-grained — isolates exactly which processor has a bug
- The PoC already demonstrates this pattern (see `test_uninterruptible_frame` in `poc/pipeline-architecture/pipeline.py`)

**Cons:**
- Cannot test cross-processor interactions (streaming overlap, cascading cancel)
- Cannot test pipeline wiring bugs (wrong linking order, frame routing errors)
- Cannot test timing-dependent behavior (barge-in during TTS playback)
- Mocked `push_downstream` may not catch async queue ordering issues

**Verdict:** Essential foundation — must have these. But insufficient alone.

---

### B. Pipeline Integration Tests with Fake Providers

Build complete test pipelines using in-process fake processors that simulate real timing behavior.

**How it works:**
- `FakeLLM`: emits tokens at configurable rate (e.g., one every 30ms), response text is configurable
- `FakeTTS`: records received sentences and timestamps, simulates synthesis delay
- `FakeSTT`: converts TextFrame to TranscriptionFrame with configurable delay
- Wire into a full Pipeline, push input, wait for output, assert behavior

**Example test pattern:**
```python
async def test_streaming_overlap():
    llm = FakeLLM(response="First sentence. Second sentence.", token_delay=0.03)
    tts = FakeTTS(synth_delay=0.1)
    pipe = Pipeline([FakeSTT(), MockClassifier(), llm, SentenceAggregator(), tts, MockTransport()])
    await pipe.start()
    await pipe.push(TextFrame(text="query"))
    await asyncio.sleep(2.0)
    
    # TTS should have started sentence 1 BEFORE LLM finished generating sentence 2
    assert tts.sentences_started[0][1] < llm.generation_end_time
```

**Coverage:**
- Streaming overlap — TTS starts before LLM finishes (the core latency optimization)
- Barge-in propagation through the full pipeline
- Session isolation — two pipelines, interrupt one, verify other continues
- End-to-end frame flow — verifies pipeline wiring correctness
- Provider error simulation — FakeLLM raises mid-stream, verify graceful degradation

**Existing PoC validation:** The `poc/pipeline-architecture/pipeline.py` already implements this pattern with `test_basic_pipeline`, `test_streaming_overlap`, `test_barge_in`, and `test_session_isolation`. These tests pass and confirm the approach works.

**Pros:**
- Tests real pipeline behavior — streaming overlap, cancel propagation, session scoping
- Catches wiring bugs that unit tests miss
- Controllable timing via fake processor delays — not fully deterministic but reproducible
- The PoC proves this pattern works at ~50-100 lines per test

**Cons:**
- Slower — each test needs `asyncio.sleep()` for timing, typically 0.5-2s per test
- Timing assertions can be flaky under CI load (CPU contention stretches delays)
- Requires maintaining fake processor implementations alongside real ones
- Debugging failures is harder — must trace frame flow through multiple processors

**Timing flakiness mitigation:**
- Use generous bounds (assert `< 600ms` not `< 300ms`) — the PoC already does this
- Use relative timing (sentence 1 before sentence 2) rather than absolute timing
- Use `asyncio.Event` gates instead of `sleep()` where possible — fake processors can signal completion
- Mark timing-sensitive tests with `@pytest.mark.slow` and allow CI to retry once

**Verdict:** Critical for validating the pipeline's core value propositions (streaming overlap, barge-in). The PoC already demonstrates feasibility.

---

### C. Hybrid: Unit + Integration + Property-Based

Combines A and B with property-based testing (Hypothesis) for the sentence aggregator.

**Property-based tests for SentenceAggregator:**
```python
from hypothesis import given, strategies as st

@given(st.text(min_size=1, max_size=500))
def test_no_token_loss(text):
    """Every input character appears in exactly one output sentence."""
    sentences = run_aggregator_sync(text)
    reconstructed = " ".join(sentences)
    # After normalization, all content is preserved
    assert normalize(reconstructed) == normalize(text)

@given(st.text(min_size=1, max_size=500, alphabet=st.characters(whitelist_categories=('L', 'N', 'P', 'Z'))))
def test_min_length_respected(text):
    """No output sentence shorter than min_words (except final flush)."""
    sentences = run_aggregator_sync(text)
    for s in sentences[:-1]:  # Exclude final fragment
        assert len(s.split()) >= MIN_WORDS or len(s) == 0
```

**Properties worth testing:**
1. **No token loss**: All input text appears in output sentences (modulo whitespace normalization)
2. **Ordering preserved**: Output sentences appear in the same order as input text
3. **Min-length respected**: No mid-response sentence shorter than `min_words` (except final flush)
4. **Delimiter correctness**: Every sentence ends with a delimiter OR is the final fragment
5. **Idempotency**: Processing tokens one-by-one produces same output as processing in batches

**Pros:**
- Finds edge cases humans won't think of — random Unicode, empty strings, only-punctuation input, extremely long words
- Properties are the *specification* — if the property holds, the aggregator is correct by definition
- Hypothesis shrinks failing cases to minimal reproductions — easy to debug
- Catches regressions when abbreviation list or delimiter rules change

**Cons:**
- Requires synchronous wrapper around async aggregator for Hypothesis compatibility
- Only useful for the sentence aggregator — other processors have behavior too stateful/timing-dependent for property testing
- ~30 lines of property setup + sync wrapper — modest effort
- Hypothesis dependency (~2 MB) — trivial on RPi5 but still a dev dependency

**Verdict:** High value specifically for the sentence aggregator, which has the most complex rule set and the highest risk of subtle edge-case bugs. Not useful for other pipeline components.

---

## Test Scenarios (Must-Cover List)
1. Happy path: text input → direct LLM → TTS → audio output
2. Happy path: audio input → STT → classifier → LLM → TTS → audio output
3. Barge-in during TTS playback → all stages cancel, new input processed
4. Barge-in during tool execution → tool result preserved (UninterruptibleFrame)
5. Sentence aggregator: "Dr. Smith went to Washington. He arrived at 3.14 p.m."
6. Sentence aggregator: long response with no punctuation for 50+ words
7. Sentence aggregator: single-word response "Yes."
8. Queue drain: verify SystemFrames survive, DataFrames are dropped
9. Session isolation: interrupt in session A doesn't affect session B
10. Provider error mid-stream: LLM connection drops during token streaming

### Scenario-to-Approach Mapping

| Scenario | Unit (A) | Integration (B) | Property (C) |
|----------|:--------:|:----------------:|:-------------:|
| 1. Text happy path | - | **Primary** | - |
| 2. Audio happy path | - | **Primary** | - |
| 3. Barge-in during TTS | - | **Primary** | - |
| 4. UninterruptibleFrame survival | **Primary** | Secondary | - |
| 5. Abbreviation/decimal handling | **Primary** | - | Secondary |
| 6. Long unpunctuated response | **Primary** | - | **Primary** |
| 7. Single-word response | **Primary** | Secondary | - |
| 8. Queue drain behavior | **Primary** | Secondary | - |
| 9. Session isolation | - | **Primary** | - |
| 10. Provider error mid-stream | - | **Primary** | - |

---

## Test Infrastructure Requirements

### What's Needed
1. **pytest + pytest-asyncio**: Standard Python async test runner — zero learning curve
2. **Fake processors** (FakeLLM, FakeTTS, FakeSTT): Already prototyped in the PoC as Mock* classes. Promote to reusable test fixtures with configurable delays and responses.
3. **Frame collector utility**: A simple processor that captures all frames it receives — used as pipeline tail in tests
4. **Hypothesis** (optional, for property tests): `pip install hypothesis`, dev dependency only

### What's NOT Needed
- **No mocking framework** (unittest.mock): Fake processors are simpler and more explicit than mock.patch. The frame pipeline's architecture (explicit interfaces, queue-based) makes dependency injection trivial.
- **No test containers**: All tests use in-process fakes — no Docker, no external services
- **No snapshot testing**: Frame sequences are small enough to assert inline
- **No coverage enforcement**: Focus on scenario coverage, not line coverage metrics

### Test Organization
```
tests/
├── unit/
│   ├── test_sentence_aggregator.py    # Boundary rules, abbreviations, decimals
│   ├── test_queue_drain.py            # SystemFrame survival, UninterruptibleFrame
│   └── test_frame_types.py            # Priority ordering, dataclass behavior
├── integration/
│   ├── test_pipeline_flow.py          # Happy paths, end-to-end frame delivery
│   ├── test_streaming_overlap.py      # TTS starts before LLM finishes
│   ├── test_barge_in.py              # Cancel propagation, session isolation
│   └── test_provider_errors.py        # Mid-stream failures, timeout handling
├── property/
│   └── test_aggregator_properties.py  # Hypothesis-based token preservation
└── conftest.py                        # Shared fixtures: FakeLLM, FakeTTS, etc.
```

**Estimated test count:** ~25-35 tests total across all levels.

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. Unit Only | B. Integration Only | C. Hybrid (A+B+Property) |
|--------|:-:|:-:|:-:|
| Covers streaming overlap | No | Yes | Yes |
| Covers barge-in propagation | Partial (queue drain only) | Yes | Yes |
| Covers sentence edge cases | Yes | No | Yes (+ property fuzzing) |
| Catches wiring bugs | No | Yes | Yes |
| Test speed | <1s total | ~10-20s total | ~15-25s total |
| Flakiness risk | None | Low-Medium | Low-Medium |
| Implementation effort | ~100 lines | ~200 lines | ~350 lines |
| Finds unknown edge cases | No | No | Yes (Hypothesis) |
| Dependencies | pytest only | pytest + pytest-asyncio | + hypothesis |

### Recommendation: Approach C (Hybrid), with phased implementation

**Why not A alone:** Unit tests can't validate the pipeline's core value propositions — streaming overlap and barge-in propagation are cross-processor behaviors. The PoC already proved that integration-level tests catch real bugs that unit tests miss (e.g., the barge-in test revealed that InterruptionFrame must be broadcast to all processors, not just pushed downstream).

**Why not B alone:** Integration tests are too coarse for the sentence aggregator's edge cases. Testing "Dr. Smith" abbreviation handling through a full pipeline adds noise (STT delay, classifier, LLM fake setup) when the bug is in a single regex. Unit tests pinpoint aggregator bugs in <1ms.

**Why C:** Each level covers what the others can't:
- **Unit (A)**: Fast, deterministic tests for processor-internal logic — sentence boundaries, queue drain, frame priority
- **Integration (B)**: Validates cross-processor behaviors — streaming overlap, cancel propagation, session isolation  
- **Property (C)**: Fuzzes the sentence aggregator (the component with the most complex rules) to find edge cases humans won't anticipate

**Phased rollout:**
1. **Phase 1 (build with pipeline)**: Unit tests for sentence aggregator + integration tests for streaming overlap and barge-in. These test the two hardest-to-debug behaviors. ~200 lines.
2. **Phase 2 (after aggregator stabilizes)**: Property-based tests for sentence aggregator. Wait until the boundary rules are settled to avoid constant property updates. ~50 lines.
3. **Phase 3 (as providers integrate)**: Integration tests for provider error handling — mid-stream disconnect, timeout, failover. ~100 lines.

### Key Design Decisions

1. **pytest + pytest-asyncio as test framework**: Standard, widely understood, good async support. No custom test harness.
2. **Fake processors over mocks**: Explicit in-process fakes (FakeLLM, FakeTTS, FakeSTT) with configurable delays and responses. Mocking frameworks add indirection without benefit when the interfaces are simple.
3. **Unit tests for sentence aggregator edge cases**: Abbreviations, decimals, ellipsis, force-break — tested at the processor level for speed and precision.
4. **Integration tests for cross-processor behaviors**: Streaming overlap, barge-in, session isolation — tested with full pipeline and fake processors.
5. **Property-based tests for aggregator invariants**: Token preservation, ordering, min-length constraints — catches unknown edge cases via Hypothesis fuzzing.
6. **Relative timing assertions over absolute**: Assert "TTS sentence 1 starts before LLM finishes" not "TTS starts at 250ms" — avoids CI flakiness.
7. **No external dependencies in tests**: All tests use in-process fakes — no Docker, no API keys, no network. Tests run offline on the Pi.
8. **Frame collector as test sink**: A minimal processor that records all received frames — reusable across integration tests.

### Open Questions

- Should integration tests run as part of CI or only pre-merge? At ~20s runtime, they're fast enough for CI.
- Should the fake processors live in the main package (usable for development/debugging) or test-only?
- Is there value in a "chaos" test mode that randomly injects InterruptionFrames and provider errors to find race conditions?
