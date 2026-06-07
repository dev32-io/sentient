---
description: Result envelope -- loading/success/failure, typed-error taxonomy, exhaustive folding.
paths:
  - "shared/mobile-data/**/result/**"
  - "shared/mobile-sdk/**/result/**"
---

# Result Envelope

A typed result envelope is the backbone of graceful degradation: every data-layer output is wrapped, never a raw value or a thrown exception.

- Every repository stream/op yields one of three states: loading (with last-known partial), success (data), or failure (typed error).
- Loading carries the last-known value so the UI degrades, never blank-flashes.
- Errors are values, not exceptions — caught at the data boundary and emitted as failure; the flow never throws to a ViewModel.
- A failure carries a typed error: a kind, a recoverable flag, a retry policy, and a user-facing message. The UI picks its affordance from the policy, never by string-matching the message.
- Only the user-facing message reaches the UI; diagnostic causes are logged at the boundary, never surfaced.
- ViewModels fold the envelope exhaustively — one branch per state, no `else` that swallows failure.
- Log every emitted state at the boundary.
- Keep the error taxonomy additive: new kinds extend it; never repurpose an existing kind.

> When a rule is unclear, read `agents/docs/mobile-data/result-envelope-details.md`.
