# Task Acceptance: Add calendar resource classes and capability roots

## Deliverables

- Establish calendar-private and calendar-household as first-class capability resource classes with household-aware path derivation, so a CalendarStore can be opened under a frozen, path-confined capability.

## Acceptance

- grant for calendar-private roots under the user home dir and carries principal.role
- grant for calendar-household roots under sharedDataRoot/<householdId>
- A calendar-private capability does not cover a calendar-household root path and vice versa

## Boundary Proof

- access-manager and capability tests assert both new classes, household path derivation, and cross-class isolation
