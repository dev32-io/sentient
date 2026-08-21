# Task Brief: Make iOS CalendarViewModel a thin SKIE state adapter

## Contribution Goal

iOS CalendarViewModel consumes shared CalendarExperience as a cancellable SKIE AsyncSequence and translates SwiftUI intents without duplicating database, network, filtering, pagination, prefetch, recurrence, or conflict policy.

## Boundary — Included

- Swift UI-state mapping from shared SKIE StateFlow AsyncSequence
- Typed intent forwarding for view/date/filter/navigation/preview/editor/mutations
- Owned cancellable collection task and acknowledged outcomes
- Native date/time control conversion only
- Swift tests for thinness, cancellation, and identity forwarding

## Required Work

- 1. Replace direct list/create/update/delete orchestration with the session CalendarExperience exported from IosUserSession/UserSession.
- 2. Consume shared StateFlow through SKIE `for await` in one explicitly owned cancellable task; cancel on ViewModel/session disposal without closing the authenticated experience on route changes.
- 3. Map shared projections/state into Swift models for Day/Week/Month/Year, filters/facets, agenda, preview/editor, freshness/offline, loading/empty/error/conflict/permission/confirmation, and mutation availability.
- 4. Forward Today, previous/next, date/view selection, filters/search, refresh, preview, Add/Edit, recurrence scope, save, delete confirmation, conflict reread, close, and acknowledgements as shared intents without reconstructing policy.
- 5. Keep only iOS-native date/time picker presentation/conversion and preserve shared all-day identity, timezone, originalStart, occurrenceId, eventId, revision, and scope unchanged.
- 6. Avoid a Combine mirror or native cache/repository. Ensure MainActor UI updates, cancellation propagation, and no stale session emissions.
- 7. Rewrite CalendarViewModelTests for cache-first sequence mapping, all views, Month-to-Day/Week retention, filters, freshness/offline, mutation scopes/identity, conflict, route recreation, and exact intent forwarding.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-viewmodel.

## Context

- Current CalendarViewModel performs one-shot shared use-case CRUD and owns a one-year network range. Replace it with session-scoped shared state/intent consumption.
- Exact UI state references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. The adapter exposes supported reference states but owns no geometry or prototype fields.
- Use Swift concurrency/SKIE directly; do not add a Combine bridge. Preserve current typed NavigationStack and route-scoped ViewModel lifecycle.

## Boundary — Excluded

- SwiftUI component implementation
- NativeSqliteDriver/session construction
- Shared coordinator policy
- New navigation/store architecture
- Prototype visual constants or data

## Interfaces and Dependencies

- Consumes session-scoped CalendarExperience StateFlow/intent API through SKIE.
- Produces observable Swift CalendarUiState and methods consumed by controlled SwiftUI calendar views.
