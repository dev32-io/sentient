# Task Brief: Implement the observable shared calendar store

## Contribution Goal

shared/mobile-data can atomically persist and observe complete authorized month snapshots and account/backend-scoped preferences through a narrow CalendarCacheStore.

## Boundary — Included

- CalendarCacheStore common interface and SQLDelight implementation
- Atomic complete-window replacement and observable reads
- Preference read/write observation
- Namespace purge/switch and lifecycle ordering
- Freshness/access metadata operations and deterministic serialization
- Store-level transaction and observation tests

## Required Work

- 1. Wrap generated SQLDelight queries in a common CalendarCacheStore that exposes domain models/flows, not generated row classes.
- 2. Implement atomic replacement only for a fully aggregated month window: write occurrences and complete marker together, update fetched/last-accessed metadata, and remove superseded rows without a partial observable state.
- 3. Reconstruct Calendar V2 identity, recurrence, scope, visibility, all-day/timed, revision, metadata, and raw RFC3339 offset-bearing start/end/originalStart strings losslessly. The current V2 wire does not provide an IANA zone; do not synthesize one. Treat decode failure as a typed cache failure and never expose partial content.
- 4. Expose observable snapshot and preference flows suitable for combining into StateFlow; query invalidation must naturally emit after one successful transaction.
- 5. Persist and validate account/backend-scoped view, anchor, filters, and search preferences, retaining selected facets even when absent from the current interval.
- 6. Implement transactional namespace purge/switch and close semantics. Session disposal must be able to cancel observation before purge/switch so stale private rows cannot emit to a successor session.
- 7. Add store tests for complete replacement, rollback, observable emission count/order, raw temporal round-trip, decode failure, preference persistence, namespace isolation, purge, close, fetched/access metadata, and no content-bearing diagnostics.

## Integration Expectation

Deliver this contribution for integration in stage mobile-calendar-store.

## Context

- The SQLDelight foundation provides generated tables and a platform-neutral driver seam. The remote SdkCalendarRepository must remain stateless.
- The store will feed one shared StateFlow used by Android collectors and iOS SKIE async-sequence consumers; generated SQLDelight types must not leak into native UI contracts.
- Exact mobile reference paths are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Persist the supported four-view/filter vocabulary only; never persist prototype sample semantics.

## Boundary — Excluded

- REST pagination, revalidation, prefetch, or LRU policy decisions
- Android/iOS protected path construction
- Native ViewModels or UI
- Offline mutation queueing
- Changes to sentient-design files

## Interfaces and Dependencies

- Consumes CalendarDatabase and its driver/open-close seam from mobile-sqldelight-foundation.
- Produces CalendarCacheStore snapshot/preference/freshness flows and transaction methods for CalendarExperience.
