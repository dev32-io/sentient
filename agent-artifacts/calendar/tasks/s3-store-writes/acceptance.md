# Task Acceptance: CalendarStore create/update/delete with household adult-gate and event-tz storage

## Deliverables

- Implement CalendarStore create, update, and delete with the household adult-gate (adult|admin), event-tz-anchored timestamp storage (UTC instant + event tz id, or all-day date), atomic EXDATE/exception replacement, and cascade delete, returning typed results.

## Acceptance

- Create persists all fields: timed events as a UTC instant plus an event tz id (default household tz), all-day events as a local date, plus raw rrule, EXDATE, tags, visibility, importance, group, and notification policy
- Update atomically replaces EXDATE and exceptions; delete cascades EXDATE/exception rows
- A child or guest household write/update/delete returns a typed failure (admin and adult allowed)
- Updating or deleting a non-existent event returns a typed not-found failure

## Boundary Proof

- Store write tests cover UTC-instant + event-tz-id and all-day-date round-trip, EXDATE/exception persistence and atomic replacement, cascade delete, child/guest household rejection, admin allowed, and not-found
