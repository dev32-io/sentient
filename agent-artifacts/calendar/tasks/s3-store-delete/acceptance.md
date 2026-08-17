# Task Acceptance: CalendarStore delete with cascade and household gate

## Deliverables

- Implement CalendarStore.delete removing the base event plus its EXDATE and exception rows atomically, enforcing the household write-gate, with typed not-found.

## Acceptance

- Delete removes the base event and its EXDATE/exception rows
- Deleting a non-existent event returns a typed not-found failure
- Household delete enforces the adult-gate

## Boundary Proof

- Delete tests cover cascade removal, non-adult household rejection, and not-found
