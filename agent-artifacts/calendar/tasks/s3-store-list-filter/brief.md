# Task Brief: CalendarStore list/filter with recurrence expansion and visibility

## Contribution Goal

Implement CalendarStore.list/filter that expands recurring events via expandRecurrence within the bounded window, applies EXDATE/exception overrides, filters by date range/group/tags/importance, and applies role-based visibility filtering.

## Boundary — Included

- Implement list(filter) expanding recurring events via expandRecurrence within [start, end]
- Apply EXDATE skips and exception overrides during expansion
- Filter by date range, group, tags, and importance
- Apply role-based visibility filtering omitting adults events for non-adult roles
- Typed list result

## Required Work

- 1. Implement list(filter) in calendar-store.ts selecting base events overlapping [start, end].
- 2. Expand recurring events via expandRecurrence from s2-expand-recurrence within the window, applying EXDATE skips and exception overrides.
- 3. Apply group, tags, and importance filters and role-based visibility filtering (omit adults for non-adult cap.role).
- 4. Add tests for the COUNT=10 BYDAY=MO,FR expansion, EXDATE/exception application, each filter dimension, and child adults-event omission (AC-003).
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-list-filter.

## Context

- CalendarStore.get with visibility filtering exists from s3-store-read-visibility; expandRecurrence exists from s2-expand-recurrence.
- list/filter must expand recurring events via the shared engine, apply EXDATE/exception overrides, and apply role-based visibility filtering.
- Filters: date range, scope (private/household is implicit via capability), group, tags, importance.

## Boundary — Excluded

- create/update/delete, get

## Interfaces and Dependencies

- Produces: CalendarStore.list with expansion and visibility filtering consumed by tools, nudge, and REST.
- Consumes: expandRecurrence from s2-expand-recurrence; CalendarStore.get visibility pattern from s3-store-read-visibility.
