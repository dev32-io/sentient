# Task Brief: Add atomic single-occurrence update and cancellation

## Contribution Goal

Recurring events support rich updates or deletion of exactly one original occurrence without altering adjacent slots or series identity.

## Boundary — Included

- this_occurrence update with rich sparse overrides and clear semantics
- this_occurrence delete as canonical cancelled exception
- Effective timing/visibility validation, revision increment, and focused tests

## Required Work

- 1. Extend the sequential mutation service branch for applyTo this_occurrence after verifying originalStart is a generated slot of the selected recurring segment, including a moved existing exception.
- 2. Implement sparse update for title, description, start, end, visibility, importance, group, and tags. Apply explicit null clears only to optional fields and empty-array tag clears; reject scope, recurrence, identity, revision, notification, and unknown fields.
- 3. Validate the resulting effective occurrence: nonempty title, configured input limits, compatible start/end kinds, valid interval, event-timezone anchoring, and role-safe visibility projection.
- 4. Preserve originalStart and occurrenceId when a start override moves the displayed occurrence. Preserve base duration when start changes without end; respect an explicit end/clear according to the V2 contract.
- 5. Implement this_occurrence delete as one cancelled exception keyed by originalStart. Remove or reject a conflicting EXDATE so one slot never has both exclusion and cancellation representations; leave every adjacent slot unchanged.
- 6. Compare-and-swap expectedRevision when supplied and increment the base segment revision exactly once for a successful update or cancellation. Repeated cancellation of an unavailable/cancelled slot returns occurrence_not_found rather than creating duplicate state.
- 7. Evaluate authority and target visibility without leaking hidden base/occurrence data. A child cannot mutate household state, and a hidden target is indistinguishable from absent.
- 8. Add mutation and expansion integration tests for E2E-008 and E2E-009: every local field, null/empty clears, moved identity, child/adult effective visibility, search/filter projection compatibility, canonical cancellation, adjacent occurrence preservation, stale revision, and rollback.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-occurrence-mutations.

## Context

- The mutation core owns command validation, authority, revisions, and transaction result mapping.
- An occurrence is selected by eventId plus originalStart; occurrenceId is returned for clarity but never grants authority.
- The exception row JSON can represent every approved event-local override without a schema migration because this is a fresh V2 baseline.

## Boundary — Excluded

- Changing recurrence on one occurrence
- Creating successor series
- This-and-following or entire-series behavior
- HTTP/tool adapter changes

## Interfaces and Dependencies

- Extends mutateCalendarEvent with this_occurrence update/delete using the persistence transaction and recurrence membership helpers.
- Produces the same CalendarMutationResult/error contract established by calendar-v2-mutation-core.
