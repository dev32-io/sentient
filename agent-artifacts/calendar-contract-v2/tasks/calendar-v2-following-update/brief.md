# Task Brief: Add atomic this-and-following series updates

## Contribution Goal

Updating one recurring slot and all following slots atomically creates a correct successor segment for COUNT- and UNTIL-bounded recurrences without data loss.

## Boundary — Included

- this_and_following update transaction
- COUNT, UNTIL, first-slot, changed-recurrence, and child-state semantics
- Conflict, stale revision, cancellation, rollback, and successor-result tests

## Required Work

- 1. Extend mutateCalendarEvent for update with applyTo this_and_following and require eventId plus originalStart. Resolve the target by original generated slot even when an exception moved its displayed start.
- 2. Use the recurrence splitter to compute a prefix ending before the selected slot and a successor beginning at the selected slot. Generate a new immutable successor eventId and return it in CalendarMutationResult.
- 3. For COUNT, persist prefix count N-1 and successor count oldCount-N+1, counting cancelled/excluded generated slots. For UNTIL, persist the previous generated slot as prefix terminal bound and keep the old terminal bound on the successor.
- 4. Apply base-event changes to the successor, including allowed recurrence replacement and event-local metadata. Re-anchor successor start/end and canonical recurrence at the selected original slot while preserving event timezone and duration semantics.
- 5. Partition exceptions and exclusions by original key: past stays with prefix; selected/future compatible state moves exactly once to successor. Absorb or retain the selected override exactly once so its requested changes are not double-applied.
- 6. If the requested successor recurrence no longer generates any retained future child key, return recurrence_conflict. Do not drop, remap, or partially move that state.
- 7. Handle a split at the first generated slot as an atomic whole-segment replacement/update with no empty prefix, while still returning the surviving/new identity contract consistently.
- 8. Compare-and-swap expectedRevision on the selected segment. Within one SQLite transaction update/delete the prefix as appropriate, create the successor, partition all child/tag state, and assign deterministic initial/surviving revisions. An abort or failure at any step rolls back every change and generated ID ownership.
- 9. Preserve private/household capability and visibility authority throughout; model-emitted eventId/originalStart never broadens access.
- 10. Add focused tests for E2E-010, E2E-011, and E2E-012: COUNT with cancelled/EXDATE slots, UNTIL across DST, moved target, first-slot split, compatible future migration, incompatible rule conflict, stale revision, induced failure rollback, and a covering expansion proving no duplicate/missing slot.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-following-update.

## Context

- The pure recurrence splitter provides generated-slot membership, COUNT/UNTIL partitioning, and child-state partition proposals.
- The V2 persistence transaction can compare-and-swap the prefix, insert a successor, and move child rows atomically.
- After a successful split, prefix and successor are independent persisted series; later entire_series operations do not traverse lineage.

## Boundary — Excluded

- This-and-following delete/truncate
- Single-occurrence and entire-series logic already owned by neighboring tasks
- REST/tool/client adapters

## Interfaces and Dependencies

- Extends the shared mutation service with this_and_following update, consuming recurrence split proposals and V2 transactions.
- Produces a mutation result naming prefix eventId, successorEventId, applied scope, and successor/prefix revision as defined by the V2 contract.
