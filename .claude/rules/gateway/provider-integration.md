---
paths:
  - "gateway/src/**/*.ts"
---
# Provider Integration Rules

- All providers implement Protocol interfaces (structural typing, not inheritance).
- Streaming providers return `AsyncGenerator<T>`. Consumers use `for await...of`.
- Every provider call MUST accept an `AbortSignal` parameter.
- Timeout every external call. Pick a value matched to the upstream's worst-case latency, not a guess.
- Raw WebSocket for the local STTService and Fish Audio TTS. The gateway no longer dials an LLM provider directly — Hermes owns the LLM call. Gateway dials each per-user Hermes worker via ACP JSON-RPC over WebSocket (`hermes-adapter-client/`); search / delete / get / getMessages route through a sentient-plugin REST sidecar (one per profile) at `acpPort + DASHBOARD_PORT_OFFSET`.
- Configuration via YAML file with `${ENV_VAR}` resolution for secrets only.

> When a rule is unclear, read `agents/docs/provider-integration-details.md`.
