# Task Acceptance: Define calendar domain types, RRULE subset, and store contracts

## Deliverables

- Establish the pure domain contracts (event, occurrence, recurrence subset, visibility, importance, group, tags, exceptions) and the CalendarStore result/error vocabulary consumed by the store, recurrence engine, tools, nudge, and REST.

## Acceptance

- CalendarEvent, Occurrence, and CalendarEventId types capture single and recurring bases with visibility, importance, group, tags, and exceptions
- The bounded RRULE subset is expressed as types and a raw rrule string convention
- Typed store results and CalendarNotifier no-op interface are defined

## Boundary Proof

- Type-level and unit tests for RRULE subset validation and occurrence shape compile and pass
