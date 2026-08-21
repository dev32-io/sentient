# Task Brief: Make iOS CalendarViewModel a thin SKIE state adapter

## Contribution Goal

iOS CalendarViewModel consumes shared CalendarExperience as a cancellable SKIE AsyncSequence and translates SwiftUI intents without duplicating database, network, filtering, pagination, prefetch, recurrence, or conflict policy.

## Boundary — Included

- SKIE bridge-compatibility proof for the complete CalendarExperienceState
- Swift UI-state mapping from shared SKIE StateFlow AsyncSequence
- Typed intent forwarding for view/date/filter/navigation/preview/editor/mutations
- Owned cancellable collection task and acknowledged outcomes
- Native date/time control conversion only
- Swift tests for thinness, cancellation, and identity forwarding

## Required Work

- 1. First build the XCFramework and compile a focused Swift test that iterates the complete CalendarExperienceState through SKIE, including nested view projections, facets, freshness, draft, conflict, and error values. If a type does not bridge safely, split only that boundary into a small number of shared flows or exported DTOs before UI work proceeds.
- 2. Replace direct list/create/update/delete orchestration with the session CalendarExperience exported from IosUserSession/UserSession.
- 3. Consume shared StateFlow through SKIE `for await` in one explicitly owned cancellable task; cancel on ViewModel/session disposal without closing the authenticated experience on route changes.
- 4. Map shared projections/state into Swift models for Day/Week/Month/Year, filters/facets, agenda, preview/editor, freshness/offline, loading/empty/error/conflict/permission/confirmation, and mutation availability.
- 5. Forward Today, previous/next, date/view selection, filters/search, refresh, preview, Add/Edit, recurrence scope, save, delete confirmation, conflict reread, close, and acknowledgements as shared intents without reconstructing policy.
- 6. Keep only iOS-native date/time picker presentation/conversion and preserve shared all-day identity, raw offset-bearing originalStart, occurrenceId, eventId, revision, and scope unchanged.
- 7. Avoid a Combine mirror or native cache/repository. Ensure MainActor UI updates, cancellation propagation, and no stale session emissions.
- 8. Rewrite CalendarViewModelTests for SKIE bridge coverage, cache-first sequence mapping, all views, Month-to-Day/Week retention, filters, freshness/offline, mutation scopes/identity, conflict, route recreation, and exact intent forwarding.

## Integration Expectation

Deliver this contribution for integration in stage ios-calendar-viewmodel.

## Context

- Current CalendarViewModel performs one-shot shared use-case CRUD and owns a one-year network range. Replace it with session-scoped shared state/intent consumption.
- Exact UI state references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. The adapter exposes supported reference states but owns no geometry or prototype fields.
- Use Swift concurrency/SKIE directly; do not add a Combine bridge. Preserve current typed NavigationStack and route-scoped ViewModel lifecycle.
- The new CalendarExperienceState is substantially richer than existing streams; prove its nested Kotlin lists/enums/data classes bridge cleanly through the generated XCFramework before SwiftUI surface work depends on it.

## Boundary — Excluded

- SwiftUI component implementation
- NativeSqliteDriver/session construction
- Shared coordinator policy beyond a narrowly required export-shape repair
- New navigation/store architecture or Combine bridge
- Prototype visual constants or data

## Interfaces and Dependencies

- Consumes session-scoped CalendarExperience StateFlow/intent API through a verified SKIE export shape.
- Produces observable Swift CalendarUiState and methods consumed by controlled SwiftUI calendar views.
