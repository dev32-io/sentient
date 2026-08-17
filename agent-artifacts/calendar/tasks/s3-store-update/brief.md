# Task Brief: CalendarStore update with household write-gate

## Contribution Goal

Implement CalendarStore.update applying partial/full field updates, replacing EXDATE and exceptions atomically, reusing the household write-gate, and returning typed results.

## Boundary — Included

- Implement update(id, patch) replacing base fields and EXDATE/exceptions in one transaction
- Reuse the household write adult-gate for household updates
- Typed update result including not-found

## Required Work

- 1. Implement update(id, patch) in calendar-store.ts replacing base fields and fully replacing EXDATE/exceptions atomically.
- 2. Route household updates through the existing household write adult-gate.
- 3. Return a typed not-found failure when the event is absent.
- 4. Add tests for field patch, EXDATE/exception replacement, non-adult household update rejection, and not-found.
- 5. Run tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s3-store-update.

## Context

- CalendarStore.create and the household write-gate exist from s3-store-create.
- Update must replace EXDATE and exception sets atomically and reuse the household write-gate.

## Boundary — Excluded

- Create, delete, read/list, recurrence, visibility

## Interfaces and Dependencies

- Produces: CalendarStore.update with the household write-gate.
- Consumes: CalendarStore.create and the write-gate from s3-store-create.
