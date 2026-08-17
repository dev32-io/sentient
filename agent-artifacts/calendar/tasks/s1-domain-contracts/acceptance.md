# Task Acceptance: Define calendar domain types, RRULE subset, wire schema, and store contracts

## Deliverables

- Establish the pure domain contracts (event, occurrence, recurrence subset, visibility, importance, group, tags, exceptions), the event-tz-anchored timestamp representation (UTC instant + event tz id default household; all-day date), the isAdult predicate, the JSON wire schema with golden fixtures, the CalendarStore close() lifecycle interface, and the typed result/error vocabulary consumed by the store, recurrence engine, tools, nudge, and REST.

## Acceptance

- CalendarEvent, Occurrence, and CalendarEventId types capture single and recurring bases with visibility, importance, group, tags, and exceptions
- The bounded RRULE subset is expressed as types and a raw rrule string convention; timed events store a UTC instant plus an event tz id (default household tz); all-day events store a local date with no time
- An isAdult(role) predicate (adult | admin; admin has no bypass) is defined
- A concrete JSON wire schema with request/response/error envelopes, tz-aware values (UTC instant + event tz id, or all-day date), and shared golden fixtures is defined
- CalendarStore exposes a close() lifecycle interface and a CalendarNotifier no-op seam

## Boundary Proof

- Type-level and unit tests for RRULE subset validation, tz-aware timestamp representation, isAdult, and wire-schema golden fixtures compile and pass
