# Task Brief: CalendarStore delete with cascade and household gate

## Contribution Goal

Implement CalendarStore.delete removing the base event plus its EXDATE and exception rows atomically, enforcing the household write-gate, with typed not-found.

## Boundary — Included

- Implement delete(id) cascading EXDATE and exceptions in one transaction
- Reuse the household write adult-gate for household deletes
- Typed delete result including not-found

## Required Work

- 1. Implement delete(id) in calendar-store.ts removing the base event and cascading EXDATE/exception rows in one transaction.
- 2. Route household deletes through the household write adult-gate.
- 3. Return a typed not-found failure when the event is absent.
- 4. Add tests for cascade removal, non-adult household delete rejection, and not-found.
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-delete.

## Context

- CalendarStore create/update exist from s3-store-create/s3-store-update; delete is a confirm-tier tool and must still enforce the household write-gate.
- Delete must cascade EXDATE and exception rows.

## Boundary — Excluded

- Create, update, read/list, recurrence, visibility

## Interfaces and Dependencies

- Produces: CalendarStore.delete.
- Consumes: CalendarStore from s3-store-create/s3-store-update.
