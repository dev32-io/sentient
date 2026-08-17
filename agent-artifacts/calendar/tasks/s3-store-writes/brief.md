# Task Brief: CalendarStore create/update/delete with household adult-gate and UTC storage

## Contribution Goal

Implement CalendarStore create, update, and delete with the household adult-gate (adult|admin), UTC-stored timestamps, atomic EXDATE/exception replacement, and cascade delete, returning typed results.

## Boundary — Included

- Implement create(event) persisting base event, EXDATE rows, and exceptions atomically with UTC-stored timestamps
- Implement update(id, patch) atomically replacing base fields and EXDATE/exceptions
- Implement delete(id) cascading EXDATE/exception rows
- Household write adult-gate: reject household-scope writes when isAdult(cap.role) is false (child/guest), allow adult and admin
- Typed create/update/delete results including not-found

## Required Work

- 1. Implement create() in gateway/src/calendar/calendar-store.ts persisting the base event, EXDATE rows, and exceptions-table rows in one transaction with UTC-stored timestamps.
- 2. Implement update(id, patch) replacing base fields and fully replacing EXDATE/exceptions atomically; implement delete(id) cascading EXDATE/exception rows.
- 3. Add the household write adult-gate: when cap.resource is calendar-household and isAdult(cap.role) is false, return a typed failure before any write.
- 4. Return typed not-found failures for absent events on update and delete.
- 5. Add tests for UTC round-trip, EXDATE/exception persistence and atomic replacement, cascade delete, child/guest household rejection, admin allowed, and not-found.
- 6. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-writes.

## Context

- CalendarStore factory and schema exist from s1-store-schema-factory with compiling stubs and a close() lifecycle seam.
- The adult-equivalent predicate is isAdult(role) = adult | admin (admin has no bypass; it is simply treated as adult); household writes are adult-gated at the store as defense-in-depth (the pre-PDP rejection lives in the tool provider).
- Timestamps are stored as UTC instants; the serving timezone transformation happens at read/expansion, not at write.
- Create must persist the base event, EXDATE list, and exceptions-table rows atomically; update replaces EXDATE/exceptions atomically; delete cascades.

## Boundary — Excluded

- Read, list/filter, visibility filtering, and recurrence expansion (s3-store-reads)

## Interfaces and Dependencies

- Produces: CalendarStore create/update/delete with the household adult-gate and UTC storage.
- Consumes: openCalendarStore from s1-store-schema-factory; domain types and isAdult from s1-domain-contracts.
