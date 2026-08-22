# Task Brief: Define the calendar V2 domain and wire contracts

## Contribution Goal

All gateway, tool, REST, web, and mobile work can consume one explicit calendar V2 contract without internal CalendarTime-shaped model arguments or unresolved wire decisions.

## Boundary — Included

- Revisioned event, effective occurrence, bounded page, recurrence input, mutation command/result, and stable error types and Zod schemas
- Exact model-oriented temporal and recurrence input shapes
- A version-2 golden wire fixture and focused schema/fixture tests

## Required Work

- 1. Replace the V1 calendar external schemas in gateway/src/calendar/types.ts with a coherent V2 contract while retaining internal CalendarTime only as a normalized domain/storage type.
- 2. Define human temporal input as a string accepting YYYY, YYYY-MM, YYYY-MM-DD, or offset-bearing RFC 3339 at minute, second, or fractional-second precision.
- 3. Define structured recurrence input with frequency daily/weekly/monthly/yearly, optional positive interval, full-name weekdays for weekly rules, and exactly one finite count or until bound; canonical RRULE remains internal.
- 4. Define read calendar scope private/household/all and writable scope private/household. Define mutation scope this_occurrence/this_and_following/entire_series.
- 5. Pin tool/REST field names: eventId; optional originalStart for an occurrence; required applyTo on every update/delete; optional expectedRevision; and update changes. Omitted calendar scope is represented as private by boundary adapters, not as ambient authority.
- 6. Define the occurrence-local changes allowlist: title, description, start, end, visibility, importance, group, and tags, with null clearing only for optional fields and an empty array clearing tags. Scope, identity, revision, notification policy, and recurrence are forbidden for this_occurrence; recurrence changes are available only to this_and_following or entire_series.
- 7. Define concise occurrence projections with eventId, occurrenceId, originalStart, recurring, scope, revision, title, start, optional end, and the effective mutable metadata needed by get/mutation. Keep eventId distinct from occurrenceId.
- 8. Define version-2 REST envelopes; list pages use events plus optional opaque nextCursor rather than more. Define mutation results with operation, appliedTo, eventId, optional successorEventId, and resulting revision when a record remains.
- 9. Define stable external error codes including invalid_time, invalid_range, range_too_wide, invalid_scope, forbidden, not_found, occurrence_not_found, result_too_large, recurrence_conflict, conflict, aborted, and io_error, with room for boundary-specific authentication errors.
- 10. Update gateway/src/calendar/fixtures/calendar-wire.json to pin create, page, occurrence, mutation, and error examples without real user content. Update gateway/src/calendar/types.test.ts to prove strict parsing, explicit mutation scope, rich clear semantics, identity separation, and rejection of old nested CalendarTime tool inputs.
- 11. Preserve internal role and calendar domain concepts used by store/recurrence code, but remove no security gate and add no compatibility parsing for prior REST payloads.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-contracts.

## Context

- Current contract definitions live in gateway/src/calendar/types.ts and gateway/src/calendar/fixtures/calendar-wire.json; the KMP test build generates its golden fixture from that JSON.
- This is a coordinated clean cutover. Version 2 request/response shapes replace prior calendar wire contracts; no compatibility aliases or migration shapes are required.
- Calendar scope and mutation scope are different concepts. Occurrence identity is the original recurrence slot even when an override moves the displayed start.

## Boundary — Excluded

- Temporal normalization implementation
- SQLite schema or persistence changes
- Tool provider, REST handler, web, or Kotlin implementation
- Calendar UI changes and existing-data migration

## Interfaces and Dependencies

- Produces authoritative TypeScript domain types and Zod boundary schemas in gateway/src/calendar/types.ts plus version-2 fixture JSON consumed by gateway and generated KMP tests.
- Consumers receive exact names for CalendarCreateInput, CalendarQueryInput/Page, CalendarMutationCommand/Result, CalendarError, CalendarEvent, CalendarOccurrenceProjection, revisions, scopes, and recurrence input.
