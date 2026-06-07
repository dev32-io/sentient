---
paths: ["shared/mobile-sdk/src/commonMain/**"]
---
# Coroutines / Flow Public Surface

- The SDK exposes a SPLIT observable surface, not one aggregate: continuous state as hot state-holders (`StateFlow`) plus one-shot notifications as a separate no-loss hot stream.
- Continuous state uses `StateFlow` (conflation is fine — latest wins). One-shot, no-loss notifications (token deltas, task upserts, cycle/commit, errors) use a buffered `SharedFlow` with suspend-on-overflow. NEVER stream deltas over a `StateFlow` — conflation drops tokens.
- Errors are a public notification on the event stream, not thrown across the boundary. Audio/VAD internals stay folded into the state surface, not separately exposed.
- Public async ops are `suspend` funcs; streams are `Flow`. These bridge cleanly to Swift async / AsyncSequence.
- Do NOT expose `Channel`, `Deferred`, raw `Job`, or callback-lists across the public boundary — wrap them.
- Sealed classes for state + events → exhaustive Swift enums. Keep hierarchies flat.
- Every coroutine runs in a consumer-cancellable scope (tie to connect/disconnect, or the session scope). No `GlobalScope`.
- Log every state transition and every emitted event.

> When a rule is unclear, read `agents/docs/mobile-sdk/coroutines-flow-surface-details.md`.
