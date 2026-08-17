# Task Acceptance: CalendarStore get/list/filter with visibility and serving-timezone recurrence expansion

## Deliverables

- Implement CalendarStore get and list/filter that expand recurring events via expandRecurrence in the configured serving timezone, apply EXDATE/exception overrides, filter by date range/group/tags/importance, and apply role-based visibility filtering (child/guest omit adults; adult/admin see them).

## Acceptance

- AC-003 at store: child/guest omit visibility:adults events; adult and admin see them
- AC-005: FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences through the store path in a covering window; EXDATE removes a named instance and an exceptions override replaces one
- list filters by date range, group, tags, and importance and expands recurring events in the configured serving timezone (America/Vancouver default)
- get returns single base events by id; a non-existent id returns a typed not-found failure

## Boundary Proof

- Store read tests cover COUNT=10 BYDAY=MO,FR expansion, EXDATE/exception application, each filter, child/guest adults-event omission, admin/adult visibility, serving-tz expansion, and not-found
