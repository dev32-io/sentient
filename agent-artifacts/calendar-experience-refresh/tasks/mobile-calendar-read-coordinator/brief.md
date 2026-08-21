# Task Brief: Implement shared cache-first calendar observation and revalidation

## Contribution Goal

One shared CalendarExperience loads persisted preferences and complete cached months immediately, then performs explicit authorized-all paginated revalidation and emits fresh state atomically to both native clients.

## Boundary — Included

- CalendarExperience commonMain state and intent API
- Cache-first observation of visible windows and preferences
- Explicit scope-all remote pagination and complete atomic replacement
- Stale-while-revalidate freshness/error state
- Equivalent-request coalescing and obsolete foreground cancellation
- SettingsComponent/session exposure and deterministic tests

## Required Work

- 1. Introduce one authenticated-session CalendarExperience with a StateFlow containing validated preferences, visible/selected interval, unfiltered authorized occurrences, projections, facets, freshness, loading/offline/error metadata, and mutation availability.
- 2. On observation start or window change, subscribe to SQLDelight preferences and complete cached month snapshots; emit usable cached projections immediately and never replace valid cache with a blank Loading envelope.
- 3. Revalidate through the stateless CalendarRepository using explicit scope `all`; follow every nextCursor, detect loops, deduplicate stable occurrence identity, and write one complete snapshot transaction only after all pages succeed.
- 4. Keep cached data visible on connectivity failure and update freshness/error metadata only. Treat authorization, forbidden, malformed, decode, and contract failures distinctly rather than hiding them as offline cache fallback.
- 5. Coalesce equivalent window requests, cancel obsolete foreground work with CancellationException propagation, and prevent cancelled/incomplete pagination from replacing a complete snapshot.
- 6. Persist view/anchor/filter intents through CalendarCacheStore and recompute projections locally without refetching filtered subsets.
- 7. Expose CalendarExperience from the authenticated shared component without moving stateful policy into SdkCalendarRepository or shared/mobile-sdk.
- 8. Add coroutine/SQLDelight tests for cache-first timing, delayed remote response, complete multipage success, later-page failure, cursor loop, cancellation, coalescing, local filter updates, freshness transitions, and one observable fresh emission.

## Integration Expectation

Deliver this contribution for integration in stage mobile-calendar-read-coordinator.

## Context

- CalendarCacheStore owns durable snapshots; SdkCalendarRepository remains the stateless remote boundary; pure projection functions own Day/Week/Month/Year and filtering.
- The exact mobile interaction references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. The shared state must directly support their horizontal filters, compact views, agenda rows, floating view selector, sheets, and freshness states without copying fixtures or visual code.
- Continuous UI state uses StateFlow; Android collects it and iOS consumes its SKIE AsyncSequence.

## Boundary — Excluded

- Adjacent-window prefetch and twelve-month eviction
- Create/edit/delete mutations
- Android/iOS driver path construction
- Native UI
- Offline mutation queueing

## Interfaces and Dependencies

- Consumes CalendarCacheStore, pure mobile projection functions, and stateless CalendarRepository.
- Produces CalendarExperience StateFlow and read/presentation intents for platform ViewModels.
