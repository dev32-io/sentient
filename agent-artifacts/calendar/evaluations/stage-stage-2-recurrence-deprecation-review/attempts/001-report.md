# Evaluation Report: stage-stage-2-recurrence-deprecation-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- CalendarStore capability gate, path isolation, close() lifecycle, and ahead-of-binary policy
- expandRecurrence bounded subset, EXDATE/exception, all-day, and serving-timezone DST correctness
- HA calendar tool removal across provider output, catalog, and role defaults (no profile migrator)

## Observations

MERGE: NO

Major CAL-REC-001: weekly BYDAY expansion consumes COUNT for candidates before DTSTART, producing 9 rather than 10 occurrences for a valid Wednesday-starting MO/FR COUNT=10 rule.
Major CAL-SCHEMA-001: the frozen events baseline omits the required group filtering facet despite CalendarEvent exposing group and the story requiring group filtering.
Minor CAL-STORE-001: ahead-of-binary open applies WAL before detecting the newer version, so the documented leave-untouched policy changes journal_mode.

HA calendar-tool removal, capability gating/path isolation, fresh migration, WAL, close semantics, typecheck, and the affected test suite otherwise passed. Stage checks: typecheck passed; 75 tests passed, 0 failed.

## Evidence

- **EV-001:** cd gateway && bun run typecheck — pass
- **EV-002:** cd gateway && bun test src/calendar/calendar-store src/calendar/expand-recurrence src/tools/home src/tools/tool-tier src/api/handlers/mcp-catalog — 75 pass, 0 fail
- **EV-003:** Manual Bun reproduction outside repository — An ahead-of-binary database changed journal_mode from DELETE to WAL while retaining its newer user_version.
- **EV-004:** Manual Bun recurrence reproduction — Wednesday DTSTART with FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 returned 9 occurrences.

## Findings

- **CAL-REC-001** (high, open): COUNT is consumed by pre-DTSTART BYDAY candidates.
- **CAL-SCHEMA-001** (high, open): Events baseline has no group column.
- **CAL-STORE-001** (low, open): Ahead-of-binary open mutates journal_mode before policy detection.

## Verdict

fail

## Residual Risk

- The recurrence tests do not cover all-day, EXDATE, exception override, skipped/repeated DST times, or the DTSTART-not-first-BYDAY COUNT case.
- The ahead-of-binary test checks user_version only and would not detect pragma mutation.
