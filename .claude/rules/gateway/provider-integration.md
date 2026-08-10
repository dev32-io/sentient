---
paths:
  - "gateway/src/**/*.ts"
---
# Provider Integration Rules

- All providers implement Protocol interfaces (structural typing, not inheritance).
- Streaming providers return `AsyncGenerator<T>`. Consumers use `for await...of`.
- Every provider call MUST accept an `AbortSignal` parameter.
- Timeout every external call. Pick a value matched to the upstream's worst-case latency, not a guess.
- Raw WebSocket for the local STTService and the local-tts (LocalTTSService) TTS provider.
- Configuration via YAML file with `${ENV_VAR}` resolution for secrets only.

> When a rule is unclear, read `agents/docs/provider-integration-details.md`.
