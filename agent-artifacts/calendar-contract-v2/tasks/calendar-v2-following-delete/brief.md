# Task Brief: Add atomic this-and-following series deletion

## Contribution Goal

Deleting a selected recurring slot and all following slots atomically truncates the existing segment while preserving only earlier occurrences and creating no successor.

## Boundary — Included

- this_and_following delete/truncate transaction
- First-slot deletion, revision conflict, child cleanup, and rollback tests
- Covering-expansion proof for retained past occurrences

## Required Work

- 1. Extend mutateCalendarEvent for delete with applyTo this_and_following, requiring eventId plus originalStart and resolving the generated slot by original identity.
- 2. Compute the prefix bound using the recurrence splitter: COUNT retains N-1 generated slots; UNTIL ends at the previous generated slot. Count excluded/cancelled slots consistently with update splitting.
- 3. Atomically persist only the prefix and its past exception/exclusion/tag state. Remove selected/future child ownership and create no successor event or lineage record.
- 4. If the selected slot is first, atomically delete the whole selected persisted segment and children rather than writing a zero-count or empty prefix.
- 5. Compare-and-swap expectedRevision when supplied. Increment the surviving prefix revision exactly once; return a deletion result with no revision when the segment is fully removed.
- 6. Reject nonexistent, cancelled/unavailable, hidden, or unauthorized targets without revealing hidden state. Check cancellation before the transaction and fail closed.
- 7. Add focused E2E-013 tests for middle COUNT/UNTIL truncation, excluded/cancelled slot counting, first-slot deletion, moved occurrence targeting, stale revision, authority, induced rollback, no successor, and a covering list showing past retained and selected/future absent.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-following-delete.

## Context

- This branch shares generated-slot and prefix-bound arithmetic with this-and-following update but has a distinct final state: no selected/future segment exists.
- A target at the first generated slot deletes the selected persisted segment because an empty prefix is forbidden.
- Entire-series deletion remains scoped to the selected segment only.

## Boundary — Excluded

- Creating or updating a successor
- Single-occurrence cancellation
- Entire-series deletion already implemented in mutation core
- Tool/REST/client presentation

## Interfaces and Dependencies

- Extends the shared mutation service delete dispatcher using the same recurrence splitter and transaction contract.
- Produces CalendarMutationResult or stable conflict/not-found/forbidden/aborted/io errors.
