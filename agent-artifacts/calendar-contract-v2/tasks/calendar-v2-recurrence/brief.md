# Task Brief: Implement effective occurrences and recurrence split arithmetic

## Contribution Goal

The recurrence engine can project rich effective occurrences and compute safe COUNT/UNTIL series partitions from stable original slots.

## Boundary — Included

- Canonical recurrence creation from structured input
- Rich exception application and stable occurrence identity
- Pure generated-slot enumeration and COUNT/UNTIL split helpers
- DST, moved-exception, exclusion, and first-slot tests

## Required Work

- 1. Extend gateway/src/calendar/expand-recurrence.ts so an effective occurrence applies the allowlisted override fields title, description, start, end, visibility, importance, group, and tags while retaining eventId, occurrenceId, and originalStart independently of displayed start.
- 2. Preserve duration when only an occurrence start moves, validate same-kind override times, and ensure cancelled exceptions suppress exactly one original slot.
- 3. Canonicalize the V2 structured recurrence input into the supported bounded RRULE subset; require count or until, keep weekly weekday ordering deterministic, and reject unsupported/full-RFC constructs.
- 4. Add gateway/src/calendar/recurrence-splitter.ts exposing pure helpers that verify an originalStart is a generated slot and partition a recurrence at that slot without relying on visible list output.
- 5. For COUNT, count every generated slot including EXDATE and cancelled slots; return prefix count N-1 and successor count oldCount-N+1. For UNTIL, end the prefix at the prior generated slot and retain the old terminal bound on the successor.
- 6. Handle a split at the first generated slot without producing a zero-count/empty prefix. Use originalStart for moved exceptions and never use effective displayed start as the split key.
- 7. Partition exception and exclusion collections by canonical original key. Detect duplicate cancellation/EXDATE ownership and expose a typed recurrence_conflict when a proposed changed successor rule no longer generates a future child key.
- 8. Keep recurrence expansion bounded by injected max occurrences and days and preserve event-timezone wall-clock behavior through daylight-saving transitions.
- 9. Add focused tests covering rich overrides, visibility changes, moved occurrences, COUNT with cancelled/excluded slots, UNTIL over DST, first-slot splits, compatible child partitioning, and incompatible future exception detection. Pin the algorithmic parts of E2E-008 through E2E-012.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-recurrence.

## Context

- gateway/src/calendar/expand-recurrence.ts currently keys occurrences by original start but applies only cancellation, title, start, and end.
- COUNT ordinals already advance before EXDATE/cancellation filtering; the V2 splitter must preserve that generated-slot behavior.
- This task is pure recurrence logic. SQLite mutation orchestration is implemented separately.

## Boundary — Excluded

- SQLite writes or transaction rollback
- Authorization and visibility filtering of projected occurrences
- Tool, REST, or client schemas beyond consuming the V2 domain types

## Interfaces and Dependencies

- Consumes V2 CalendarEvent, structured recurrence, originalStart, exceptions, exclusions, and recurrence limits.
- Produces effective occurrences, canonical recurrence, generated-slot membership, prefix/successor recurrence definitions, partitioned child state, or typed recurrence errors for the mutation service.
