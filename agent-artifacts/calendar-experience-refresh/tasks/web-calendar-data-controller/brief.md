# Task Brief: Implement complete web calendar loading and preference state

## Contribution Goal

The web calendar has a tested controller that loads every page for an explicit authorized-all interval, preserves valid content through refresh/failure, owns selected filter state, and restores account/backend-scoped presentation preferences.

## Boundary — Included

- New calendar controller/hook files for anchor, selected view, visible interval, complete authorized occurrences, selected filters, loading/stale/error status, and refresh
- Explicit scope=all reads and deterministic cursor traversal
- Account/backend-scoped local preference persistence with validation
- Request cancellation/coalescing and preservation of prior valid data
- Focused controller and API integration tests

## Required Work

- 1. Implement a new calendar-specific controller/hook with injected CalendarApi and testable preference store; do not edit calendar-view.tsx or own route assembly in this task.
- 2. For each visible Day/Week/Month/Year interval, request explicit scope `all` and follow `nextCursor` until complete; reject cursor loops and never replace complete data with an incomplete or cancelled aggregation.
- 3. Maintain one complete unfiltered interval data set and selected filter state. Invoke the pure projection/filter/facet functions produced by web-calendar-projections; do not duplicate filter intersection or facet derivation in the controller.
- 4. Persist validated view, anchor/selected date, scopes, groups, tags, importance, and search by authenticated account plus backend identity; invalid values fall back safely and logout/account/backend replacement cannot reuse another namespace.
- 5. Coalesce equivalent loads, cancel obsolete interval work, keep valid content visible with refreshing/error metadata, and keep errors typed and content-free.
- 6. Define the controlled state/callback interface consumed by CalendarWorkspace, including selected filters, derived facets/projections, Add opener, and live result/view announcement text. Editor draft state is explicitly not owned here.
- 7. Add tests for multi-page aggregation, deduplication by occurrence identity, cursor loops, cancellation, failed later pages, explicit all scope, preference restore/isolation, absent selected facets, pure-derivation delegation, and stale-content retention.
- 8. Preserve gateway/webui/src/services/calendar-api.ts as the wire boundary; add only narrowly required helpers and keep event text/query/payloads out of diagnostics.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-data-controller.

## Context

- gateway/webui/src/components/calendar/calendar-view.tsx currently issues separate fixed-week reads and presents the first page as complete. This task creates new controller/preference files and must not edit calendar-view.tsx; the assembly task remains its sole replacement owner.
- gateway/webui/src/services/calendar-api.ts already supports scope, cursor, group, tags, importance, query, and exact V2 mutation contracts; this task does not change backend authority.
- Pure filter/facet derivation belongs to web-calendar-projections. The controller owns complete data plus selected filter state and invokes those pure functions.
- Exact reference paths are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. The persisted four-view/filter behavior is relevant; prototype local arrays and mutations are forbidden.

## Boundary — Excluded

- Editing or replacing calendar-view.tsx
- Calendar DOM rendering and CSS
- Preview, editor draft, recurrence chooser, or mutation orchestration
- Web offline cache
- Changes to gateway authorization or Calendar V2 wire shapes
- Use of prototype localStorage fixture data

## Interfaces and Dependencies

- Produces a web CalendarController state/intent surface consumed by CalendarWorkspace and calls pure projection/filter/facet utilities.
- Consumes createCalendarApi()/CalendarApi list contracts and web-calendar-projections; it does not produce editor draft state.
