# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Blocking Major findings:
- CAL-FINAL-001 — recurrence limits are ignored; expansion runs beyond query bounds and can return partial success after its cursor ceiling (gateway/src/calendar/expand-recurrence.ts:102-140; calendar-store.ts:53-66).
- CAL-FINAL-002 — calendar_search misses timed events by default and ignores its importance filter (gateway/src/bootstrap/product-tools/calendar-provider.ts:376-380).
- CAL-FINAL-003 — impossible all-day dates are accepted, and parseRRule accepts impossible UNTIL components (gateway/src/calendar/types.ts:149-168,302-334).
- CAL-FINAL-004 — the advertised create request schema incorrectly requires server timestamps (gateway/src/calendar/types.ts:238-264).
- CAL-FINAL-005 — REST error envelopes are mapped to unknown-error by the web client; auth/invalid-body paths bypass the declared envelope and error-code status mapping is incomplete (gateway/src/api/handlers/calendar.ts:315-331; gateway/webui/src/services/_helpers.ts:29-40).
- CAL-FINAL-006 — REST PATCH can update the opposite scope when the requested scope has no matching id (gateway/src/api/handlers/calendar.ts:166-189).
- CAL-FINAL-007 — aborted update/delete tool calls still reach the store (gateway/src/bootstrap/product-tools/calendar-provider.ts:389-399).
- CAL-FINAL-008 — private and household nudges are capped independently, so the session prompt can exceed the configured aggregate cap (gateway/src/bootstrap/phase-services.ts:349-355).
- CAL-FINAL-009 — the web editor shifts timed events and stores the non-IANA timezone id `browser` (gateway/webui/src/components/calendar/calendar-view.tsx:27-34,92-95).
- CAL-FINAL-010 — iOS update folding appends a base response instead of replacing the occurrence row, producing duplicates (ios/App/Settings/Calendar/CalendarViewModel.swift:187-196).
- CAL-FINAL-013 — the added golden fixture is not consumed by web/SDK/REST/tool paths; those tests duplicate literals, leaving the required shared wire proof absent.

Non-blocking Minor findings:
- CAL-FINAL-011 — iOS all-day bounds use GMT formatting instead of the device calendar (ios/App/Settings/Calendar/CalendarViewModel.swift:87-105,217-220).
- CAL-FINAL-012 — tool notificationPolicy patches are not converted to CalendarEvent.notification and therefore do not persist (gateway/src/bootstrap/product-tools/calendar-provider.ts:389-392).

Fresh checks passed, but they do not cover these cases: gateway unit 2445 passed/4 skipped; focused gateway 118 passed; TypeScript typecheck passed; webui 143 passed/typecheck passed; mobile SDK, mobile-data, and Android calendar checks passed. Sanitized reproductions are outside the repository under /tmp/calendar-review-probes.json, /tmp/calendar-rest-scope-probe.json, /tmp/calendar-nudge-combined-probe.json, /tmp/calendar-wire-error-probe.json, and /tmp/calendar-review-iso.json.

## Evidence

- **EV-001:** bun run test:unit — gateway 2445 passed, 4 skipped, 0 failed
- **EV-002:** bun run typecheck — all workspace typechecks passed
- **EV-003:** cd gateway && bun test src/calendar src/bootstrap/product-tools/calendar-provider.test.ts src/api/handlers/calendar.test.ts src/access src/tools/home src/tools/role-defaults.test.ts src/api/handlers/mcp-catalog.test.ts — 118 passed, 0 failed
- **EV-004:** cd gateway/webui && bun run test:unit && bun run typecheck — 143 tests passed; typecheck passed
- **EV-005:** ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Calendar*' :shared:mobile-sdk:compileDebugKotlin — BUILD SUCCESSFUL
- **EV-006:** ./gradlew :shared:mobile-data:testDebugUnitTest --tests '*Calendar*' :shared:mobile-data:compileDebugKotlin — BUILD SUCCESSFUL
- **EV-007:** ./gradlew :android:testDebugUnitTest --tests '*Calendar*' :android:compileDebugKotlin — BUILD SUCCESSFUL
- **EV-008:** cat /tmp/calendar-review-probes.json — sanitized contract probes reproduce invalid create envelope, invalid date acceptance, search omissions, ignored recurrence cap, and aborted update store call
- **EV-009:** cat /tmp/calendar-rest-scope-probe.json — sanitized scope probe shows private PATCH updating household store
- **EV-010:** cat /tmp/calendar-nudge-combined-probe.json — sanitized prompt probe shows 12 combined lines against a six-line per-scope cap
- **EV-011:** cat /tmp/calendar-wire-error-probe.json — sanitized web client probe maps a calendar error envelope to unknown-error
- **EV-012:** cat /tmp/calendar-review-iso.json — sanitized timezone probe shows local Auckland midnight formatted as the prior GMT date

## Findings

- **CAL-FINAL-001** (high, open): Recurrence limits are ignored; large bounded rules can run excessively and the cursor ceiling returns partial success.
- **CAL-FINAL-002** (high, open): Default search misses timed events and importance is not forwarded.
- **CAL-FINAL-003** (high, open): Impossible all-day dates and impossible raw UNTIL components are accepted.
- **CAL-FINAL-004** (high, open): Valid create envelopes without server timestamps are rejected.
- **CAL-FINAL-005** (high, open): Calendar error envelopes become unknown-error in the web client and handler error mapping is inconsistent.
- **CAL-FINAL-006** (high, open): PATCH can mutate the opposite scope when the requested scope misses.
- **CAL-FINAL-007** (high, open): Aborted update/delete calls still reach the store.
- **CAL-FINAL-008** (high, open): Two independently capped scope nudges can exceed the session cap.
- **CAL-FINAL-009** (high, open): Timed edit values are interpreted in the wrong zone and new timed events use non-IANA `browser`.
- **CAL-FINAL-010** (high, open): Successful update appends a base row instead of replacing the occurrence row.
- **CAL-FINAL-011** (low, open): All-day query dates are formatted in GMT rather than device-local time.
- **CAL-FINAL-012** (low, open): Tool notificationPolicy updates are ignored by the store patch path.
- **CAL-FINAL-013** (high, open): The golden fixture is not consumed outside gateway; clients/tests duplicate values.

## Verdict

fail

## Residual Risk

- The manager-accepted final-E2E residual CAL-E2E-005 remains: the web current-week view intentionally shows only the current seven-day window rather than all ten covering-window recurrence occurrences.
- Previously accepted stage verification gaps remain: bootstrap/prompt-cache lifecycle coverage and the Android drawer integration test are weaker than the task proof requires. No credentials, transcripts, tokens, or private content were used in evidence.
