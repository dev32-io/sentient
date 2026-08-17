# Task Brief: Define calendar domain types, RRULE subset, wire schema, and store contracts

## Contribution Goal

Establish the pure domain contracts (event, occurrence, recurrence subset, visibility, importance, group, tags, exceptions), the event-tz-anchored timestamp representation (UTC instant + event tz id default household; all-day date), the isAdult predicate, the JSON wire schema with golden fixtures, the CalendarStore close() lifecycle interface, and the typed result/error vocabulary consumed by the store, recurrence engine, tools, nudge, and REST.

## Boundary — Included

- CalendarEvent, Occurrence, and CalendarEventId types with UTC-instant + event-tz-id timed fields and all-day-date fields
- Bounded RRULE subset types and the raw rrule string convention
- Visibility, Importance, Group, Tags, and exception-override types
- isAdult(role) predicate (adult | admin; no bypass) and an event-tz-id type (default household tz)
- CalendarConfig (recurrence limits, nudge budget) and CalendarNotifier no-op interface
- CalendarStore result/error vocabulary and a close() lifecycle interface
- A concrete JSON wire schema (request/response/error envelopes, tz-aware values, list window inclusivity, exhaustive error mapping) plus shared golden fixtures

## Required Work

- 1. Create gateway/src/calendar/types.ts with CalendarEvent, Occurrence, CalendarEventId, RRULE subset types, Visibility, Importance, Group, Tags, and exception override types; timed fields are a UTC instant plus an event tz id (default household tz); all-day fields are a local date.
- 2. Define isAdult(role) = adult | admin (documenting no bypass), an event-tz-id type (default household tz), CalendarConfig (recurrence limits, nudge budget), and CalendarNotifier as a no-op interface.
- 3. Define the CalendarStore result/error vocabulary and a close() lifecycle interface (closed-handle semantics).
- 4. Define the concrete JSON wire schema (request/response/error envelopes, tz-aware values [UTC instant + event tz id, or all-day date], list window inclusivity, exhaustive error mapping) and shared golden fixtures consumed by REST, tools, web, and SDK.
- 5. Add focused type-level and unit tests for RRULE subset parsing, tz-aware representation, isAdult, and golden fixtures.
- 6. Run typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s1-domain-contracts.

## Context

- No calendar domain types exist yet; MemoryStore is the closest capability-store precedent but is filesystem-based.
- The design pins a bounded RRULE subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT or UNTIL, BYDAY for weekly; stored as a raw rrule string plus an exceptions table and EXDATE.
- Timezone model aligns to the existing gateway convention (gateway/src/context/message-time.ts): UTC instants rendered with an explicit offset via the swappable TimeZoneProvider (host zone today; household-location later). Timed events store a UTC instant plus an event tz id (default household tz) so recurrence stays wall-clock-anchored and DST-correct; all-day events store a local date (no time, no tz). The calendar never needs a user current tz — that belongs to the future scheduler.
- Visibility is a structured field (everyone|adults) filtered by cap.role at the query layer; isAdult(role) = adult | admin (admin is simply adult-equivalent, no bypass); importance is normal|important|pinned; group is singular, tags is a set.
- REST, tools, web, and the KMP SDK must share one wire schema; a forward-compatible notification column and a CalendarNotifier no-op interface are part of the contract.
- The calendar is durable dated/timed storage only — NOT the home for relative reminders, recurring briefings, or interval reminders (future scheduler).

## Boundary — Excluded

- SQLite schema, migrations, and store implementation
- Recurrence expansion algorithm (separate task)
- Tools, nudge, REST, UI
- User-current-tz / scheduler / free-reminder record types (future)

## Interfaces and Dependencies

- Produces: gateway/src/calendar/types.ts (and wire schema/fixtures) consumed by the store, expandRecurrence, tools, nudge, REST, web, and SDK.
- Consumes: UserRole (from shared); the existing TimeZoneProvider convention from message-time; defines its own Scope enum so it does not depend on ResourceClass.
