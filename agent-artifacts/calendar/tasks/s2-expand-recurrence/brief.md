# Task Brief: expandRecurrence pure module (bounded subset, EXDATE, exceptions, all-day, serving-timezone DST)

## Contribution Goal

Deliver the pure expandRecurrence(event, windowStart, windowEnd, servingTz, { exceptions, exdates }) module that produces Occurrences within a bounded window for all bounded-subset cases, EXDATE skips, exception overrides, all-day, and DST boundaries in the serving timezone, with typed failures for malformed or unbounded RRULEs.

## Boundary — Included

- Daily, weekly/BYDAY, monthly, and yearly expansion with INTERVAL
- COUNT and UNTIL bounding and query-window bounding with defined inclusivity
- EXDATE skip and exceptions-table override application
- All-day event expansion and DST-boundary timed event expansion in the serving IANA timezone (America/Vancouver) over UTC-stored instants
- Explicit skipped/repeated local-time (DST) policy
- Typed failure for malformed or unbounded RRULE with no partial expansion

## Required Work

- 1. Create gateway/src/calendar/expand-recurrence.ts as a pure module taking a CalendarEvent (or base + rrule), a [windowStart, windowEnd] window, an IANA serving timezone (America/Vancouver default), and exceptions/exdates.
- 2. Interpret DTSTART/UNTIL as UTC instants expanded in the serving timezone; define window inclusivity.
- 3. Implement daily/weekly(BYDAY)/monthly/yearly expansion with INTERVAL and COUNT/UNTIL bounding, plus hard query-window bounds.
- 4. Implement EXDATE skip and exceptions-table override application.
- 5. Implement all-day expansion and DST-boundary timed expansion using Intl/IANA semantics; define and test skipped/repeated local-time behavior.
- 6. Return a typed failure (no partial expansion) for malformed or unbounded RRULE.
- 7. Add focused tests for each case including the DST boundary in America/Vancouver and the COUNT=10 BYDAY=MO,FR scenario.
- 8. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s2-expand-recurrence.

## Context

- No recurrence library exists in the repo; gateway/src/context/message-time.ts provides TimeZoneProvider, formatStamp, and Intl-based IANA zone handling.
- The recurrence engine is the single source shared by store queries, agent tools, and the nudge composer.
- Bounded subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT or UNTIL, BYDAY for weekly; stored raw rrule; EXDATE plus an exceptions table for overrides.
- Timestamps are UTC instants; expansion runs in the configured serving timezone (America/Vancouver default); DST skipped/repeated local times need an explicit policy, not raw Date arithmetic.

## Boundary — Excluded

- Store CRUD integration (handled by store read task)
- Tools, nudge, REST

## Interfaces and Dependencies

- Produces: expandRecurrence pure module in gateway/src/calendar/expand-recurrence.ts consumed by store queries, tools, and nudge.
- Consumes: CalendarEvent, Occurrence, RRULE subset, and exception types from s1-domain-contracts; TimeZoneProvider from message-time.
