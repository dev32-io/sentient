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

## Caching-Decorator Exception — Device Chat Mirror

A dedicated **stateful caching decorator** MAY sit BEHIND the existing `ConversationRepository` / `SessionsRepository` interfaces when implementing the durable device chat mirror. ViewModels and usecases are unchanged; only `ChatComponent` wires the decorator in.

Key invariants:

- The decorator wraps the stateless SDK repo (the pure passthrough still exists underneath).
- The decorator owns a `ChatDatabase` (SQLDelight) + a connection-scoped `mirrorScope`; both live only while the user is authenticated — `ChatComponent.close()` cancels the scope and releases the driver.
- DB writes run on an injected IO dispatcher (`ioDispatcher()` expect/actual). Never on the CPU (`Dispatchers.Default`) pool.
- **Live entries write through by `entryId`** (upsert-by-entryId; idempotent). In-flight pre-commit bubbles (empty `entryId`) are skipped until committed.
- **REST reload REPLACES a conversation's rows** — delete + repopulate in a SINGLE SQLDelight `transaction { }` so the reactive flow emits once (cached → REST, never an empty intermediate). Do NOT cross-path upsert. Live `entryId`s are gateway-minted UUIDs; REST `entryId`s are positional `${conversationId}:${index}` — different namespaces, no shared Hermes message id. Merging by `entryId` across paths is undefined. The replace is ARMED by the live `SessionSwitched` echo and CONSUMED on the first NON-EMPTY snapshot (a switch passes through an empty `replaceMirror(emptyList())` while awaiting REST — deleting on that empty snapshot would flash the painted rows).
- **Instant paint from the local DB, anchored on the CLIENT switch intent — not the server echo.** `ChatComponent` owns a shared `activeConversationIntent`; the client switch path (`CachingSessionsRepository.switchTo*`) sets it before delegating, and `CachingConversationRepository.timeline` reads it via `flatMapLatest → messagesFor(id)`. A cold launch paints the route's cached rows before the SDK connects; SDK/REST refresh layers on.
- Session list uses pull-based cache-then-refresh: warm cache → return instantly + background refresh; cold cache → await REST so the first paint is never an empty flash.
- **Smart-async deletion**: diff local session ids against the server set; delete stale rows (+ cascade messages) in the background. Fetch a generous window (`REFRESH_LIMIT = 1000`) so the diff sees the full server set — a paged window would misread off-page sessions as deleted.
- **Durable resume cursor** is persisted via dependency inversion: the SDK defines `ResumeCursorStore`; mobile-data implements `SyncCursorStoreResumeAdapter` over multiplatform-settings. Save is coalesced per cycle. Clear on `recovered:false`.

> For rationale, file map, gotchas, and test approach, read `agents/docs/mobile-data/chat-mirror-details.md`.

> When a rule is unclear on the base pattern, read `agents/docs/mobile-data/repositories-details.md`.
