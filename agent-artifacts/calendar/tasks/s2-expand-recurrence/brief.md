# Task Brief: expandRecurrence pure module (bounded subset, EXDATE, exceptions, all-day, event-tz DST)

## Contribution Goal

Deliver the pure expandRecurrence(event, windowStart, windowEnd) module that produces Occurrences within a bounded window for all bounded-subset cases, EXDATE skips, exception overrides, all-day, and DST boundaries in the event's own timezone, with typed failures for malformed or unbounded RRULEs.

## Boundary — Included

- Daily, weekly/BYDAY, monthly, and yearly expansion with INTERVAL
- COUNT and UNTIL bounding and query-window bounding with defined inclusivity
- EXDATE skip and exceptions-table override application
- All-day event expansion (local dates) and DST-boundary timed event expansion in the event's IANA timezone over UTC-stored instants
- Explicit skipped/repeated local-time (DST) policy in the event tz
- Typed failure for malformed or unbounded RRULE with no partial expansion

## Required Work

- 1. Create gateway/src/calendar/expand-recurrence.ts as a pure module taking a CalendarEvent (with its event tz id), a [windowStart, windowEnd] window, and exceptions/exdates.
- 2. Interpret DTSTART/UNTIL as UTC instants expanded in the event's tz (default household tz); define window inclusivity.
- 3. Implement daily/weekly(BYDAY)/monthly/yearly expansion with INTERVAL and COUNT/UNTIL bounding, plus hard query-window bounds.
- 4. Implement EXDATE skip and exceptions-table override application.
- 5. Implement all-day expansion (local dates) and DST-boundary timed expansion in the event's IANA tz using Intl semantics; define and test skipped/repeated local-time behavior.
- 6. Return a typed failure (no partial expansion) for malformed or unbounded RRULE.
- 7. Add focused tests for each case including the DST boundary in the event tz and the COUNT=10 BYDAY=MO,FR scenario.
- 8. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s2-expand-recurrence.

## Context

- No recurrence library exists in the repo; gateway/src/context/message-time.ts provides TimeZoneProvider, formatStamp, and Intl-based IANA zone handling.
- The recurrence engine is the single source shared by store queries, agent tools, and the nudge composer.
- Bounded subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT or UNTIL, BYDAY for weekly; stored raw rrule; EXDATE plus an exceptions table for overrides.
- Timezone model: timed events are UTC instants with an event tz id (default household tz); recurrence expands in the EVENT's tz so a '9am Monday' stays anchored where the event happens and DST is preserved. All-day events are local dates (no time). The engine never needs a user current tz.
- DST skipped/repeated local times in the event tz need an explicit policy, not raw Date arithmetic.

## Boundary — Excluded

- Store CRUD integration (handled by store read task)
- Tools, nudge, REST
- User-current-tz / scheduler (future)

## Interfaces and Dependencies

- Produces: expandRecurrence pure module in gateway/src/calendar/expand-recurrence.ts consumed by store queries, tools, and nudge.
- Consumes: CalendarEvent (with event tz id), Occurrence, RRULE subset, and exception types from s1-domain-contracts; TimeZoneProvider/Intl from message-time.
