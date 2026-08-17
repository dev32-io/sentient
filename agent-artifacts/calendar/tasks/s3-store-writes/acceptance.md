# Task Acceptance: CalendarStore create/update/delete with household adult-gate and UTC storage

## Deliverables

- Implement CalendarStore create, update, and delete with the household adult-gate (adult|admin), UTC-stored timestamps, atomic EXDATE/exception replacement, and cascade delete, returning typed results.

## Acceptance

- Create persists all fields with timestamps stored as UTC instants, including raw rrule, EXDATE, tags, visibility, importance, group, and notification policy
- Update atomically replaces EXDATE and exceptions; delete cascades EXDATE/exception rows
- A child or guest household write/update/delete returns a typed failure (admin and adult allowed)
- Updating or deleting a non-existent event returns a typed not-found failure

## Boundary Proof

- Store write tests cover UTC field round-trip, EXDATE/exception persistence and atomic replacement, cascade delete, child/guest household rejection, admin allowed, and not-found
