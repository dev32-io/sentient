# Task Acceptance: CalendarStore update with household write-gate

## Deliverables

- Implement CalendarStore.update applying partial/full field updates, replacing EXDATE and exceptions atomically, reusing the household write-gate, and returning typed results.

## Acceptance

- Update modifies base event fields and replaces EXDATE/exceptions atomically
- AC-004: a non-adult household update returns a typed failure with no permission.request
- Updating a non-existent event returns a typed not-found failure

## Boundary Proof

- Update tests cover field patch, EXDATE/exception replacement, non-adult household rejection, and not-found
