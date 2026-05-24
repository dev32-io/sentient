# Gateway Pipeline Consumer API PoC

Demonstrates that a developer can wire up the full voice gateway pipeline
in <50 lines with zero internal knowledge of stages, providers, or frame types.

## Key insight

The developer interacts with `createVoicePipeline()` which returns a `FlowManager`.
They feed it utterance lifecycle events and iterate over pipeline output events.
All stage composition, provider lifecycle, and streaming overlap are hidden.

## Files

- `pipeline-sdk.ts` — The library: FlowManager, stage composition, provider adapters
- `consumer.ts` — The <50 line consumer code (what a developer actually writes)
- `mock-providers.ts` — Mock STT/TTS/LLM for testing without API keys
- `test-consumer.ts` — Runnable test proving the consumer API works
