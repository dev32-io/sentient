# Task Brief: Implement bounded effective-occurrence calendar queries

## Contribution Goal

One shared query service provides authorized get/list/search projections, deterministic REST paging, and complete-or-error model results across private and household calendars.

## Boundary — Included

- Shared get/list/search query service and concise projector
- Authorized all-scope aggregation, deterministic cursor paging, aggregate early stop, and tool completeness/size decisions
- Nudge-safe effective query compatibility and focused security/overflow tests

## Required Work

- 1. Add gateway/src/calendar/calendar-query.ts and a concise occurrence projector that consume the V2 persistence, temporal, recurrence, and limit interfaces.
- 2. Implement get by eventId plus optional originalStart. Resolve only inside requested scope (default private; all for reads), apply the effective override, and return not_found/occurrence_not_found for absent, hidden, cancelled, or unauthorized targets without disclosing which condition occurred where security requires non-disclosure.
- 3. Implement list and search over both timed and all-day base candidates in one service, expand only within the normalized window, apply exceptions first, then effective visibility, title/description search, group, all-tags, and importance filters.
- 4. Aggregate private and household only for explicit all. If any requested store fails, return a typed failure and no partial cross-scope list. Keep child/adult visibility decisions at the capability/query boundary.
- 5. Sort deterministically by effective start, scope, eventId, and originalStart. Use private before household as the scope tie-breaker.
- 6. Implement opaque versioned continuation cursors carrying the last stable sort tuple and a hash/version of the normalized query/filter shape. Reject malformed or mismatched cursors; do not use unbounded SQL offsets.
- 7. Enforce configured query.max_occurrences with max-plus-one early stopping. REST mode returns at most query.page_size events and optional nextCursor. Tool mode must detect any next page/aggregate overflow and return result_too_large rather than a partial list.
- 8. Project list/search to concise V2 occurrence rows with unambiguous eventId, occurrenceId, originalStart, recurring, scope, revision, effective title/time, and mutation-relevant metadata. Get may include the full effective mutable event but never internal exceptions/exclusions.
- 9. Serialize the complete model projection before returning it and enforce output.max_result_chars. Return result_too_large with guidance to narrow from/to or add scope/group/tags/importance; leave the broker cap as a final unreachable backstop for normal calendar results.
- 10. Keep the existing calendar nudge behavior secure by exposing an internal bounded effective-occurrence query or adapter usable by nudge composition; update nudge tests only where the store interface changes and do not change the nudge product contract.
- 11. Add tests for E2E-001, E2E-002, E2E-004, and E2E-005: mixed time kinds, private default at the adapter input, all-scope visibility, post-override search/filter behavior, partial-scope failure, deterministic cursors, aggregate overflow, serialized overflow, and no malformed partial JSON.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-query.

## Context

- Current CalendarStore.list filters base metadata before recurrence expansion and callers issue separate timed/all-day queries.
- V2 must apply rich overrides before visibility, search, group, tags, and importance filtering, and must never leak a hidden base event through an occurrence.
- REST may page; model tools must reject any result requiring continuation or exceeding the proactive serialized budget.

## Boundary — Excluded

- Mutation writes and revision increments
- Tool JSON schemas and REST HTTP routing
- UI pagination behavior
- Unbounded/full-calendar search

## Interfaces and Dependencies

- Consumes normalized CalendarQueryInput, capability-held V2 stores, recurrence expansion, household timezone, role, and CalendarConfig limits.
- Produces CalendarPage for REST; a complete concise occurrence array or result_too_large for tools; and typed get/error results.
