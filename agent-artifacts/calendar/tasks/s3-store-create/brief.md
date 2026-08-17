# Task Brief: CalendarStore create with EXDATE/exceptions and household write-gate

## Contribution Goal

Implement CalendarStore.create (and EXDATE/exception persistence) plus the household write adult-gate that rejects non-adult household writes with a typed failure before any write.

## Boundary — Included

- Implement create(event) persisting base event, EXDATE rows, and exception overrides
- Implement the household write adult-gate (fail-fast typed failure when cap.role is not adult) applied to household-scope writes
- Typed create result/error using the s1-domain-contracts vocabulary

## Required Work

- 1. Implement create() in gateway/src/calendar/calendar-store.ts persisting the base event, EXDATE rows, and exceptions-table rows in one transaction.
- 2. Add the household write adult-gate: when cap.resource is calendar-household and cap.role is not adult, return a typed failure before any write.
- 3. Add tests for field round-trip (including raw rrule, tags, visibility, importance, group, notification column), EXDATE/exception persistence, and non-adult household create rejection.
- 4. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-create.

## Context

- CalendarStore factory and schema exist from s1-store-schema-factory with compiling stubs.
- Household writes are adult-gated at the store layer (fail-fast, no prompt) per the design.
- Create must persist the base event, EXDATE list, and exceptions-table rows.

## Boundary — Excluded

- Update, delete, read/list, recurrence expansion, visibility filtering

## Interfaces and Dependencies

- Produces: CalendarStore.create and exception/EXDATE persistence with the household write-gate.
- Consumes: openCalendarStore stubs from s1-store-schema-factory and domain types from s1-domain-contracts.
