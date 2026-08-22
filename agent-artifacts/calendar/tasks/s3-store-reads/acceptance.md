# Task Acceptance: CalendarStore get/list/filter with visibility and event-tz recurrence expansion

## Deliverables

- Implement CalendarStore get and list/filter that expand recurring events via expandRecurrence in the event's own timezone, apply EXDATE/exception overrides, filter by date range/group/tags/importance, apply role-based visibility filtering (child/guest omit adults; adult/admin see them), and return tz-aware values.

## Acceptance

- AC-003 at store: child/guest omit visibility:adults events; adult and admin see them
- AC-005: FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences through the store path in a covering window; EXDATE removes a named instance and an exceptions override replaces one
- list filters by date range, group, tags, and importance and expands recurring events in the event's own timezone (default household tz)
- get returns single base events by id; a non-existent id returns a typed not-found failure
- Read returns tz-aware values (UTC instant + event tz id, or all-day date); the store never needs a user current tz

## Boundary Proof

- Store read tests cover COUNT=10 BYDAY=MO,FR expansion, EXDATE/exception application, each filter, child/guest adults-event omission, admin/adult visibility, event-tz expansion, and not-found
