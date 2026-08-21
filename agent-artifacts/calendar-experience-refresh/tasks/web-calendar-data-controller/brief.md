# Task Brief: Implement complete web calendar loading and preference state

## Contribution Goal

The web calendar has a tested controller that loads every page for an explicit authorized-all interval, preserves valid content through refresh/failure, applies local filters, and restores account/backend-scoped presentation preferences.

## Boundary — Included

- A calendar controller/hook for anchor, selected view, visible interval, complete authorized occurrences, filters, facets, loading/stale/error status, and refresh
- Explicit scope=all reads and deterministic cursor traversal
- Account/backend-scoped local preference persistence with validation
- Request cancellation/coalescing and preservation of prior valid data
- Focused controller and API integration tests

## Required Work

- 1. Extract network and presentation state from the monolithic CalendarView into a calendar-specific controller/hook with injected CalendarApi and a testable preference store.
- 2. For each visible Day/Week/Month/Year interval, request explicit scope `all` and follow `nextCursor` until complete; reject cursor loops and never replace complete data with an incomplete or cancelled aggregation.
- 3. Maintain one complete unfiltered interval data set, derive authorized facets from it, and apply view filters locally without a second narrow-web state path.
- 4. Persist validated view, anchor/selected date, scopes, groups, tags, importance, and search by authenticated account plus backend identity; invalid values fall back safely and logout/account/backend replacement cannot reuse another namespace.
- 5. Coalesce equivalent loads, cancel obsolete interval work, keep valid content visible with refreshing/error metadata, and keep errors typed and content-free.
- 6. Add tests for multi-page aggregation, deduplication by occurrence identity, cursor loops, cancellation, failed later pages, explicit all scope, preference restore/isolation, absent selected facets, and stale-content retention.
- 7. Preserve gateway/webui/src/services/calendar-api.ts as the wire boundary; add only narrowly required helpers and keep event text/query/payloads out of diagnostics.

## Integration Expectation

Deliver this contribution for integration in stage web-calendar-data-controller.

## Context

- gateway/webui/src/components/calendar/calendar-view.tsx currently issues separate fixed-week reads and presents the first page as complete.
- gateway/webui/src/services/calendar-api.ts already supports scope, cursor, group, tags, importance, query, and exact V2 mutation contracts; this task does not change backend authority.
- Exact reference paths are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js. The persisted four-view/filter behavior is relevant; prototype local arrays and mutations are forbidden.

## Boundary — Excluded

- Calendar DOM rendering and CSS
- Preview, editor, recurrence chooser, or mutation orchestration
- Web offline cache
- Changes to gateway authorization or Calendar V2 wire shapes
- Use of prototype localStorage fixture data

## Interfaces and Dependencies

- Produces a web CalendarController state/intent surface consumed by CalendarWorkspace.
- Consumes createCalendarApi()/CalendarApi list contracts and pure web projection/filter utilities after integration.
