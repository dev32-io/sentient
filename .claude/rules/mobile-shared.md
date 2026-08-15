---
paths:
  - "shared/mobile-sdk/**"
  - "shared/mobile-data/**"
  - "android/**"
  - "ios/**"
---
# Shared mobile architecture guardrails

- The authenticated connection scope owns transport, data sources, and usecases and survives navigation. Screen state is route-scoped; logout tears down the connection.
- Backgrounding keeps the socket. Foreground performs one liveness probe and reconnects only if dead. The presence relay skips the initial foreground to avoid a double connect.
- Repositories are stateless datasource/domain mappers. Multi-source combination and event folding belong in usecases; per-screen optimistic state belongs to the screen state holder.
- The outbox is in-memory, not durable: queued entries retain a stable `pendingId`, resend safely, become failed on disconnect/unacked timeout, and disappear only on exact echoed id or authoritative cold-history replacement. Never reconcile by text or claim process-death recovery.
- Data surfaces use an exhaustive loading/success/failure envelope with typed retry policy. Diagnostic causes stay out of UI messages.
- `commonMain` contains no platform APIs. Platform capabilities enter through minimal injected or expect/actual boundaries with no platform types in common signatures.
- Continuous state uses `StateFlow`; no-loss events use the established buffered event surface. Never put token deltas or one-shot events in conflating state.
- Gateway, web SDK, and mobile SDK wire frames change together and keep exact message shapes.
