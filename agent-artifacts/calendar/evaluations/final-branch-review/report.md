# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: YES_WITH_RISK

Closure review of repair commit 06c6333b against reviewed commit 01b09ae38643d630d68607e3d03a5cb51ac09a41 found no blocking regression. All prior blocking findings CAL-FINAL-001 through CAL-FINAL-010 and CAL-FINAL-013 are resolved:
- Recurrence limits and non-partial recurrence-limit failures are enforced and tested.
- Timed default search, importance forwarding, date/RRULE validation, timestamp-free create envelopes, REST/web error envelopes, explicit PATCH scope isolation, abort propagation, aggregate nudge caps, web timezone round-tripping, iOS occurrence replacement, and shared fixture consumption are verified.

The manager-accepted non-blocking residuals remain: CAL-FINAL-011 (iOS all-day GMT formatting) and CAL-FINAL-012 (tool notificationPolicy persistence). Fresh gateway, web, mobile SDK, and iOS checks passed; the working tree is clean. Sanitized evidence: /tmp/calendar-final-branch-rereview-iteration-1.json.

## Evidence

- **EV-001:** git diff --check 1aed83a5633a2ac8472202841e21537ff0353ae9..06c6333b — pass; no whitespace errors
- **EV-002:** cd gateway && bun run typecheck && bun test src/calendar src/bootstrap/product-tools/calendar-provider.test.ts src/api/handlers/calendar.test.ts src/bootstrap/phase-services.test.ts — typecheck passed; 50 tests passed, 0 failed
- **EV-003:** cd gateway/webui && bun run test:unit && bun run typecheck — 144 tests passed, 0 failed; typecheck passed
- **EV-004:** ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Calendar*' :shared:mobile-sdk:compileDebugKotlin — BUILD SUCCESSFUL
- **EV-005:** Sanitized closure results and no sensitive content — build succeeded; 73 iOS tests passed, 0 failures

## Findings

- **CAL-FINAL-001** (high, resolved): Configured recurrence limits and typed non-partial failures are enforced.
- **CAL-FINAL-002** (high, resolved): Default search includes timed events and forwards importance.
- **CAL-FINAL-003** (high, resolved): Impossible dates and raw UNTIL components are rejected.
- **CAL-FINAL-004** (high, resolved): Create requests no longer require server timestamps.
- **CAL-FINAL-005** (high, resolved): Calendar error envelopes and status mapping are consistently handled.
- **CAL-FINAL-006** (high, resolved): Explicit PATCH scope cannot fall through to another store.
- **CAL-FINAL-007** (high, resolved): Aborted update/delete calls make zero store calls.
- **CAL-FINAL-008** (high, resolved): The combined session nudge is aggregate-capped.
- **CAL-FINAL-009** (high, resolved): Timed editor values round-trip in the browser IANA zone and no browser sentinel is stored.
- **CAL-FINAL-010** (high, resolved): Successful updates replace the matching occurrence row without duplicates.
- **CAL-FINAL-011** (low, accepted): GMT all-day formatting remains as manager-accepted residual risk.
- **CAL-FINAL-012** (low, accepted): Tool notificationPolicy persistence remains as manager-accepted residual risk.
- **CAL-FINAL-013** (high, resolved): REST/tool/web/SDK tests consume the shared golden fixture.

## Verdict

pass

## Residual Risk

- CAL-FINAL-011 and CAL-FINAL-012 remain accepted by manager and are not merge blockers.
- The previously accepted final-E2E current-week recurrence-window limitation remains outside this repair boundary.
