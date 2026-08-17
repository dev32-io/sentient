# Task Acceptance: CalendarStore create with EXDATE/exceptions and household write-gate

## Deliverables

- Implement CalendarStore.create (and EXDATE/exception persistence) plus the household write adult-gate that rejects non-adult household writes with a typed failure before any write.

## Acceptance

- A created event persists with all fields including raw rrule, EXDATE, tags, visibility, importance, group, and notification policy
- AC-004: a non-adult create or update on a household scope returns a typed failure at the store layer without emitting permission.request
- Exception overrides and EXDATE rows persist against the base event

## Boundary Proof

- Store create tests cover field round-trip, EXDATE/exception persistence, and non-adult household-write typed failure with no prompt
