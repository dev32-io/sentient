# Task Brief: Create the mutation command boundary and whole-event operations

## Contribution Goal

One authorized mutation service creates events and performs entire-series update/delete with canonical recurrence, revisions, atomicity, and typed results ready for scoped recurrence branches.

## Boundary — Included

- Mutation command dispatcher and result/error mapping
- Create canonicalization
- Entire-series update and delete with revision conflict handling
- Focused creation, whole-series, recurrence-child-conflict, and rollback tests

## Required Work

- 1. Add gateway/src/calendar/calendar-mutations.ts exposing createCalendarEvent and mutateCalendarEvent over a capability-held V2 store, normalized temporal values, recurrence helpers, and AbortSignal where invoked from tools.
- 2. Resolve omitted calendar scope to private at the boundary caller and require one writable private/household target. Recheck household adult/admin authority inside the store transaction; never accept all for a write.
- 3. Implement create from V2 input: normalize start/end, enforce configured strings/tags, canonicalize a finite structured recurrence, assign a server eventId/timestamps and revision 1, and return the V2 event projection.
- 4. Define a strict dispatcher for operation update/delete and applyTo. Reject missing applyTo, this_occurrence without originalStart, this_and_following without originalStart, originalStart on an incompatible command, and occurrence scopes for non-recurring events with actionable invalid_mutation_scope/occurrence errors.
- 5. Implement entire_series update by applying only the allowed base-event changes, including optional recurrence replacement/clear, validating effective timing and every retained child key against any changed recurrence, compare-and-swapping expectedRevision when supplied, and incrementing the surviving segment revision once.
- 6. Implement entire_series delete by validating optional expectedRevision and atomically deleting the selected persisted segment and all owned child rows. It must not follow or delete earlier/later independently split segment IDs.
- 7. When an entire-series recurrence change would orphan or ambiguously remap an exception/exclusion, return recurrence_conflict and leave the event and revision unchanged. Never silently discard child state.
- 8. Return typed CalendarMutationResult values with operation, appliedTo, eventId, optional successorEventId, and resulting revision only when a segment survives. Map hidden/unauthorized targets to non-disclosing failures.
- 9. Check AbortSignal before entering a transaction and before committing a multi-step mutation; cancellation returns aborted without partial writes.
- 10. Add tests for simplified recurring create (E2E-006), entire-series update/delete, independent split-segment identity, stale expectedRevision, recurrence-child conflict, authority, cancellation, and transaction rollback. Use synthetic content and assert logs contain no payload values.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-mutation-core.

## Context

- The V2 REST and tool adapters must call the same domain boundary and never implement recurrence behavior themselves.
- Every update/delete command carries applyTo. For a non-recurring event, entire_series is the valid scope; occurrence/following scopes are rejected rather than guessed.
- Subsequent sequential tasks add this_occurrence and this_and_following branches to this service.

## Boundary — Excluded

- Single-occurrence exception/cancellation mutation
- This-and-following split/truncate mutation
- Tool and REST argument adapters
- Legacy PATCH/DELETE support

## Interfaces and Dependencies

- Consumes CalendarCreateInput or CalendarMutationCommand, one authorized V2 store, CalendarConfig, temporal normalizer, recurrence helpers, and optional AbortSignal.
- Produces CalendarEvent/CalendarMutationResult or stable CalendarError; establishes the dispatcher extended by later mutation tasks.
