---
description: Repositories are stateless mappers over the blackbox datasource; combine/transform lives in usecases.
paths:
  - "shared/mobile-data/**/data/**"
  - "shared/mobile-data/**/model/**"
---

# Repositories

The platform SDK / datasource is a blackbox. Repositories are STATELESS mappers over its surfaces — data in, data out. They hold no accumulated state, do no cross-source combine, and do no connection gating.

- One repository per data concern; define each behind an interface so usecases test against fakes.
- A repository exposes the datasource's streams + commands mapped to domain types. It does NOT fold, accumulate, or merge — multi-source combine + transform (and any event-fold / no-loss reducer) belongs in a usecase, not here.
- Reads are cache-then-refresh where a cache exists: emit a cached partial first, then the refreshed result.
- A stateful per-screen cache (e.g. an optimistic outbox) belongs to the screen's state-holder, NOT a shared repository.
- Keep repositories free of platform and UI types. A pure passthrough mapper needs no test of its own; reserve tests for logic.

## No durable chat mirror — in-memory timeline

There is NO client-side durable store. `ChatComponent` wires the VM-facing usecases over the pure SDK passthroughs directly — `SdkConversationRepository` / `SdkSessionsRepository`, no caching decorator.

- The chat timeline is the SDK's in-memory fused `SentientSdk.timeline` (REST history replace + live appends), anchored by the SDK's own `SentientSdk.currentSessionId`. History comes from the gateway/Hermes on attach; nothing is persisted on-device.
- There is no client `activeConversationIntent` / `rememberActiveConversation` anchor seam, no `mirrorScope`, no `DatabaseDriverFactory`. The SDK `currentSessionId` is the single conversation anchor. `ChatComponent.close()` has nothing client-scoped to release.
- The optimistic outbox stays in-memory (VM-owned). Reconcile-by-pendingId off the live echo; a COLD REST history replace carries no pendingId, so the usecase drops still-present optimistic entries on the cold-replace signal (see the outbox rule).
- **Durable resume cursor:** the SDK defines `ResumeCursorStore` (dependency-inverted), but mobile-data ships NO implementation — it injects nothing and the SDK defaults to `NoOpResumeCursorStore`. The in-memory resume cursor dies with the process; a cold relaunch takes the `recovered:false` REST-refetch path.

> When a rule is unclear on the base pattern, read `agents/docs/mobile-data/repositories-details.md`.
