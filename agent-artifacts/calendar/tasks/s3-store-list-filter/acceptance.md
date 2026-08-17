# Task Acceptance: CalendarStore list/filter with recurrence expansion and visibility

## Deliverables

- Implement CalendarStore.list/filter that expands recurring events via expandRecurrence within the bounded window, applies EXDATE/exception overrides, filters by date range/group/tags/importance, and applies role-based visibility filtering.

## Acceptance

- AC-003: list/filter omits visibility:adults events for non-adult roles
- list expands recurring events via expandRecurrence within the bounded window and applies EXDATE/exception overrides
- list filters by date range, scope, group, tags, and importance
- FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences in a covering window through the store path

## Boundary Proof

- list/filter tests cover recurrence expansion (COUNT=10 BYDAY=MO,FR), EXDATE/exception application, each filter, and child adults-event omission
