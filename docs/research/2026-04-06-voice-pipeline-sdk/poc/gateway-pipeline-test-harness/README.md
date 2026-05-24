# Gateway Pipeline Test Harness PoC

Tests the gateway pipeline in complete isolation with mock inputs — zero API keys, zero network.

## Structure

- `pipeline.ts` — Minimal pipeline SDK (types + FlowManager + stages) from consumer-api PoC
- `mock-providers.ts` — Enhanced mock providers with imperative control (emit, fail, drop)
- `test-helpers.ts` — Event collector, assertion helpers, async test utilities
- `pipeline.test.ts` — Full test suite

## Test Categories

1. **Stage isolation** — Sentence aggregator and TTS stage tested independently
2. **Happy path** — Full turn: utterance → STT → LLM → TTS → audio done
3. **Partial transcripts** — Verify partials relay during speech
4. **Multi-turn** — Sequential conversations with history
5. **Barge-in** — Interrupt during processing and speaking
6. **Provider failures** — STT/LLM/TTS errors mid-stream
7. **Timeout guards** — Processing hangs detected and surfaced
8. **Edge cases** — Empty transcript, rapid fire utterances, destroy mid-turn

## Run

```bash
npx tsx pipeline.test.ts
```
