# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Re-review of only the bounded repair diff: FINAL-002, FINAL-004, and FINAL-005 are resolved; FINAL-001 is rejected per manager baseline-scope guidance, and the repair UI-path diff is empty. Focused gateway, web, mobile, root typecheck, and diff checks passed. FINAL-003 remains blocking because KMP still exports a deprecated `baseEventId` field at `CalendarModels.kt:461-462`, despite the explicit repair instruction to remove that V1 field. No new wider findings were added.

## Evidence

- **EV-001:** Focused REST/query contract verification. — 31 tests passed; gateway typecheck passed
- **EV-002:** Web recurrence and compatibility verification. — 12 tests passed; web typecheck passed
- **EV-003:** KMP/mobile-data calendar/privacy and Android compilation. — BUILD SUCCESSFUL
- **EV-004:** Repair integrity and no-UI repair-scope verification. — root typecheck and bounded repair diff check passed; repair UI-path diff is empty

## Findings

- **CAL-V2-FINAL-001** (high, rejected): Rejected: bounded repair diff has no changes under the reviewed UI paths.
- **CAL-V2-FINAL-002** (high, resolved): Resolved: query is forwarded and exact handler filtering coverage was added.
- **CAL-V2-FINAL-003** (high, open): Deprecated baseEventId remains exported on CalendarEvent, so the explicit V1-field removal requirement is unmet.
- **CAL-V2-FINAL-004** (medium, resolved): Resolved: schema minimum is 1 and zero is covered by rejection tests.
- **CAL-V2-FINAL-005** (high, resolved): Resolved: legacy RRULE types/conversion were removed and malformed legacy input is rejected before fetch.

## Verdict

fail

## Residual Risk

- The remaining KMP compatibility field may preserve downstream source compatibility, but it still violates the explicit clean-cutover acceptance and requires manager-approved resolution.
