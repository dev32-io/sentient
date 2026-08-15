---
paths:
  - "shared/mobile-sdk/**"
  - "shared/mobile-data/**"
  - "android/**"
  - "ios/**"
---
# Shared mobile architecture guardrails

- The authenticated user/connection scope owns the SDK, data sources, usecases, and `ChatComponent`; it survives navigation. Logout tears down that scope. When a rule is unclear, read `agents/docs/mobile/mobile-lifecycle-details.md`.
- Android and authenticated iOS use typed navigation. Route-scoped screen state is recreated for route changes; auth, not transport health, selects the root. When a rule is unclear, read `agents/docs/mobile/mobile-navigation-details.md`.
- Repositories are stateless SDK passthroughs. Multi-source combination and event folding belong in usecases; `OutboundCache` is VM-owned, in-memory state with a stable `pendingId`. When a rule is unclear, read `agents/docs/mobile-data/outbox-optimistic-send-details.md`.
- Data operations use the exhaustive `Loading`/`Success`/`Failure` envelope; the connection repository currently exposes `sdk.connection` directly. Diagnostic causes stay out of UI messages. When a rule is unclear, read `agents/docs/mobile-data/result-envelope-details.md`.
- `commonMain` contains no platform APIs. Platform capabilities enter through minimal injected or expect/actual boundaries with no platform types in common signatures. When a rule is unclear, read `agents/docs/mobile-sdk/commonMain-purity-details.md`.
- Gateway, web SDK, and mobile SDK wire frames change together and keep exact message shapes. Current session commands include `PermissionResponse`, `ConversationActivate`, and `SessionNew`; session listing is REST, not `SessionsList`/`SessionSwitch` WS frames. When a rule is unclear, read `agents/docs/mobile-sdk/web-sdk-mirror-contract-details.md`.
- Continuous state uses `StateFlow`; no-loss events use the established buffered event surface. Never put token deltas or one-shot events in conflating state.
