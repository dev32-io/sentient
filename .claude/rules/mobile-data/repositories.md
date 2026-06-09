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

> When a rule is unclear, read `agents/docs/mobile-data/repositories-details.md`.
