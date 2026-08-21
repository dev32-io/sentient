# Task Brief: Make Android CalendarViewModel a thin shared-state adapter

## Contribution Goal

Android CalendarViewModel lifecycle-collects shared CalendarExperience StateFlow and translates Compose intents without duplicating database, fetch, filtering, pagination, prefetch, recurrence, or conflict policy.

## Boundary — Included

- Android UI-state mapping from shared StateFlow
- Typed intent forwarding for view/date/filter/navigation/preview/editor/mutations
- Lifecycle-aware collection and one-shot announcement/event handling
- Native date/time picker value conversion only
- ViewModel tests for thinness, cancellation, and exact identity forwarding

## Required Work

- 1. Replace direct calendar use-case/network ownership with injected session CalendarExperience and lifecycle-safe StateFlow collection.
- 2. Map shared projections and state into immutable Android UI models for Day/Week/Month/Year, filters/facets, agenda rows, preview/editor drafts, freshness/offline, loading/empty/error/conflict/permission/confirmation, and mutation availability.
- 3. Forward Today, previous/next, date/view selection, filter/search, refresh, preview, Add/Edit, recurrence scope, save, delete confirmation, conflict reread, close, and acknowledgement as shared intents without rebuilding policy.
- 4. Keep only Android-specific date/time picker presentation and conversions; preserve shared all-day identity, timezone, originalStart, occurrenceId, eventId, revision, and scope unchanged.
- 5. Represent guaranteed UI announcements/outcomes in acknowledged state or an established buffered event surface, not a lifecycle-paused conflating SharedFlow.
- 6. Cancel collection with ViewModel lifecycle while leaving authenticated CalendarExperience alive across route recreation.
- 7. Rewrite focused tests to prove cache-first sequence mapping, all four views, Month-to-Day/Week retention, filters, freshness/offline, every mutation identity/scope, conflict, route recreation, and absence of direct repository/database calls.

## Integration Expectation

Deliver this contribution for integration in stage android-calendar-viewmodel.

## Context

- Current CalendarViewModel directly calls listBoth/create/update/delete and owns a one-year network range. Replace that orchestration with the authenticated session CalendarExperience.
- Exact UI state reference paths are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. The adapter must expose every supported view/filter/preview/editor/freshness state needed by that mobile composition, but must not encode geometry or prototype fixture fields.
- Follow existing Koin, Navigation Compose, lifecycle-aware collection, structured coroutines, and acknowledged-state guidance.

## Boundary — Excluded

- Compose component implementation
- SQLDelight driver/session construction
- Shared policy changes
- New navigation mechanism
- Prototype visual constants or data

## Interfaces and Dependencies

- Consumes session-scoped CalendarExperience StateFlow and intent API.
- Produces CalendarUiState and callback methods consumed by controlled Compose calendar components.
