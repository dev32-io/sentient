# Task Acceptance: expandRecurrence pure module (bounded subset, EXDATE, exceptions, all-day, event-tz DST)

## Deliverables

- Deliver the pure expandRecurrence(event, windowStart, windowEnd) module that produces Occurrences within a bounded window for all bounded-subset cases, EXDATE skips, exception overrides, all-day, and DST boundaries in the event's own timezone, with typed failures for malformed or unbounded RRULEs.

## Acceptance

- AC-005: FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences in a covering window; EXDATE removes a named instance; an exceptions-table override replaces one instance
- AC-006: an all-day event and a DST-boundary timed event expand correctly in the event's own timezone (default household tz)
- DTSTART/UNTIL are interpreted as UTC instants expanded in the event's tz; window inclusivity is defined
- A malformed or unbounded RRULE returns a typed failure with no partial expansion; skipped/repeated local times (DST) in the event tz have a defined policy

## Boundary Proof

- expandRecurrence tests cover every bounded case, EXDATE, exception override, all-day, DST boundary in the event tz, skipped/repeated local-time policy, and malformed/unbounded failure
