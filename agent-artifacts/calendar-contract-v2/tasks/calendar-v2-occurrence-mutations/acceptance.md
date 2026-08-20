# Task Acceptance: Add atomic single-occurrence update and cancellation

## Deliverables

- Recurring events support rich updates or deletion of exactly one original occurrence without altering adjacent slots or series identity.

## Acceptance

- Every approved event-local field can be changed or cleared on one occurrence and no forbidden field can.
- Moving an occurrence keeps originalStart and occurrenceId stable.
- Deleting one occurrence stores one cancellation, no duplicate EXDATE, and preserves adjacent occurrences.
- Visibility/search/filter consumers observe only the effective selected occurrence.
- Conflict, authorization failure, invalid timing, or injected storage failure leaves all state and revision unchanged.

## Boundary Proof

- Focused mutation tests and recurrence/query integration assertions pin E2E-008 and E2E-009.
- Database assertions verify one exception row and no conflicting exclusion for cancellation.
