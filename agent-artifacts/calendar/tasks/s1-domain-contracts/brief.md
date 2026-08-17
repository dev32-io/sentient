# Task Brief: Define calendar domain types, RRULE subset, and store contracts

## Contribution Goal

Establish the pure domain contracts (event, occurrence, recurrence subset, visibility, importance, group, tags, exceptions) and the CalendarStore result/error vocabulary consumed by the store, recurrence engine, tools, nudge, and REST.

## Boundary — Included

- CalendarEvent, Occurrence, and CalendarEventId types
- Bounded RRULE subset types and the raw rrule string convention
- Visibility, Importance, Group, Tags, and exception-override types
- CalendarConfig and the CalendarStore result/error vocabulary (typed create/update/delete/list/get results)
- CalendarNotifier interface as a no-op seam for future push

## Required Work

- 1. Create gateway/src/calendar/types.ts with CalendarEvent, Occurrence, CalendarEventId, RRULE subset types, Visibility, Importance, Group, Tags, and exception override types.
- 2. Define CalendarConfig (e.g. recurrence limits, nudge budget defaults) and CalendarNotifier as a no-op interface.
- 3. Define typed store result/error values for create/update/delete/list/get so the store, tools, and REST share one vocabulary.
- 4. Add focused type-level and small unit tests for the pure helpers (e.g. RRULE subset parsing validation, occurrence derivation shape) that need no DB.
- 5. Run typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s1-domain-contracts.

## Context

- No calendar domain types exist yet; MemoryStore is the closest capability-store precedent but is filesystem-based.
- The design pins a bounded RRULE subset: FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT or UNTIL, BYDAY for weekly; stored as a raw rrule string plus an exceptions table and EXDATE.
- Visibility is a structured field (everyone|adults) filtered by cap.role at the query layer; importance is normal|important|pinned; group is singular, tags is a set.
- A forward-compatible notification policy column and a CalendarNotifier interface (no-op now) are part of the contract.

## Boundary — Excluded

- SQLite schema, migrations, and store implementation
- Recurrence expansion algorithm (separate task)
- Tools, REST, nudge, UI

## Interfaces and Dependencies

- Produces: gateway/src/calendar/types.ts consumed by the store, expandRecurrence, tools, nudge, and REST.
- Consumes: ResourceClass from s1-resource-classes for capability typing.
