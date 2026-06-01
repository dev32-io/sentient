---
paths: ["shared/mobile-sdk/**"]
---
# Coroutines / Flow Public Surface

- The SDK exposes ONE observable state surface as a `StateFlow<SdkState>` (mirrors web-sdk's single state machine). VAD/error internals are NOT separate public surfaces.
- Public async ops are `suspend` funcs; streams are `Flow`. These map cleanly through SKIE to Swift `async`/`AsyncSequence`.
- Do NOT expose `Channel`, `Deferred`, raw `Job`, or callback-lists across the public boundary — SKIE/Swift ergonomics degrade. Wrap them.
- Sealed classes/interfaces for state + events (SKIE → exhaustive Swift enums). Keep hierarchies flat.
- Every coroutine is launched in a scope the consumer can cancel (tie to connect/disconnect). No `GlobalScope`.
- Log every state transition (from→to + trigger) per the logging rule.

> Details: agents/docs/mobile-sdk/coroutines-flow-surface-details.md
