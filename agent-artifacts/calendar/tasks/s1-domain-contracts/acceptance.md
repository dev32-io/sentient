# Task Acceptance: Define calendar domain types, RRULE subset, wire schema, and store contracts

## Deliverables

- Establish the pure domain contracts (event, occurrence, recurrence subset, visibility, importance, group, tags, exceptions), UTC timestamp representation, the isAdult predicate, the serving-timezone config, the JSON wire schema with golden fixtures, the CalendarStore close() lifecycle interface, and the typed result/error vocabulary consumed by the store, recurrence engine, tools, nudge, and REST.

## Acceptance

- CalendarEvent, Occurrence, and CalendarEventId types capture single and recurring bases with visibility, importance, group, tags, and exceptions
- The bounded RRULE subset is expressed as types and a raw rrule string convention; timestamps are represented as UTC instants
- An isAdult(role) predicate (adult | admin; admin has no bypass) and a serving-timezone config type (default America/Vancouver) are defined
- A concrete JSON wire schema with request/response/error envelopes and shared golden fixtures is defined
- CalendarStore exposes a close() lifecycle interface and a CalendarNotifier no-op seam

## Boundary Proof

- Type-level and unit tests for RRULE subset validation, UTC timestamp representation, isAdult, and wire-schema golden fixtures compile and pass
