# Task Brief: Normalize human calendar time and enforce query/input bounds

## Contribution Goal

Calendar boundaries can turn concise model/REST temporal strings into deterministic internal windows or actionable typed failures before any storage work.

## Boundary — Included

- Pure temporal parser and normalization module
- Range ordering, compatible-kind, configured maximum-range, string-length, and tag-cardinality validation
- Focused deterministic timezone and rejection tests

## Required Work

- 1. Add a pure gateway/src/calendar/calendar-temporal.ts boundary that accepts the V2 temporal strings and produces normalized internal all-day dates or timed CalendarTime values plus stable original keys where needed.
- 2. Accept exactly YYYY, YYYY-MM, YYYY-MM-DD, and RFC 3339 timestamps with an explicit Z or numeric offset and minute, second, or fractional-second precision. Reject impossible dates, unsupported precision, trailing junk, and offset-free timed values.
- 3. Expand query from to the represented period's first point and query to to its last point using the configured household timezone. Timed one-off values preserve their absolute instant; timed recurring DTSTART uses the configured household timezone as the wall-clock anchor and rejects an explicit offset that does not match that zone at DTSTART, rather than inventing a fixed-offset or caller-supplied IANA zone.
- 4. Normalize create/update start as the earliest represented point and end as the latest represented point. Validate compatible all-day/timed kinds, valid intervals, and end not preceding start.
- 5. Add pre-query validation for missing search bounds, inverted ranges, and configured max query days. Return typed invalid_time, invalid_range, or range_too_wide details with messages that state the bad value or measured range and the corrective action without exposing other calendar data.
- 6. Add reusable validation for configured maximum title, description, search-query, group, tag length, and tag count before query/store execution; report the offending field and configured limit without echoing content.
- 7. Ensure normalization and validation are cancellation-free pure operations and never log supplied calendar strings.
- 8. Add tests for year/month/day windows, minute/second/fractional timestamps, leap dates, daylight-saving boundaries, household-zone date periods, recurring-offset mismatch, incompatible kinds, inversion, over-limit ranges, and string/tag limits. Pin E2E-001 and E2E-003 semantics at this pure boundary.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-temporal.

## Context

- Internal recurrence and storage still use CalendarTime, while V2 external callers use strings.
- Date periods are interpreted in the configured household timezone. Query from expands to the earliest represented point and query to to the latest represented point.
- The V2 boundary does not re-expose internal timeZoneId. Timed recurring events use the configured household timezone as their wall-clock recurrence anchor; a supplied DTSTART offset must match that zone at the represented instant. Timed one-off events preserve the absolute instant.
- The implementation must accept omitted day, seconds, or milliseconds without accepting offset-free timed timestamps.

## Boundary — Excluded

- Recurrence generation or splitting
- Store queries and result pagination
- Tool and REST adapters
- Operator YAML/schema wiring, which supplies the injected limits

## Interfaces and Dependencies

- Consumes V2 temporal/query/create values and an injected resolved calendar-limits/household-timezone object from the domain contract.
- Produces normalized CalendarTime values/windows and typed CalendarError values consumed by query, mutation, tool, and REST services.
