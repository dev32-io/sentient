# Evaluation Report: stage-stage-1-contracts-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Exact V2 tool/REST fields and strict schema behavior
- Calendar scope versus mutation scope and stable occurrence identity
- Golden fixture completeness with no V1 compatibility parsing

## Observations

MERGE: NO

The focused checks pass, but the V2 contract has blocking gaps: shared search input lacks query, create rejects documented optional/defaulted fields, get cannot carry originalStart, occurrence projections cannot pass the response envelope, and mutation results do not require a surviving revision. The worktree was unchanged. A Minor test/strictness gap remains for populated V1 list fixtures and non-strict wire RRULE parsing.

## Evidence

- **EV-001:** Declared stage schema test passed. — 8 pass, 0 fail
- **EV-002:** Declared gateway typecheck passed. — tsc --noEmit passed
- **EV-003:** Reviewed diff has no whitespace errors. — passed with no output
- **EV-004:** Minimal runtime probes demonstrate the contract gaps and V1 rejection. — createMinimal=false; getOccurrenceStart=false; responseOccurrence=false; queryWithText=false; oldListPage=false; oldMutation=false

## Findings

- **CAL-V2-001** (high, open): calendarQueryInputSchema omits query, so calendar_search cannot use the authoritative shared input.
- **CAL-V2-002** (high, open): Create requires visibility, importance, and tags instead of applying documented defaults.
- **CAL-V2-003** (high, open): The get request body cannot carry originalStart.
- **CAL-V2-004** (high, open): calendarResponseSchema excludes CalendarOccurrenceProjection.
- **CAL-V2-005** (high, open): resultingRevision is optional even for surviving create/update results.
- **CAL-V2-006** (low, open): Tests do not cover a populated V1 list fixture, and wireRRuleSchema accepts unknown keys.

## Verdict

fail

## Residual Risk

- The reviewed stage does not implement downstream tool/REST adapters; those consumers may independently diverge further unless they use the corrected authoritative schemas.
