# Evaluation Report: stage-stage-7-clients-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Exact REST V2 parity across web and KMP
- No PATCH/DELETE or V1 wire fallback
- Source-level whole-series adapters preserve untouched UI compilation
- Calendar payload and token privacy in client diagnostics

## Observations

MERGE: NO
The web client and KMP client pass the declared checks and use the V2 routes/envelopes, raw temporal queries, cursor fields, POST mutation commands, whole-series adapters, and sanitized logging. Merge is blocked because KMP cannot encode V2 explicit-null update clears; cancellation during response parsing is also incorrectly swallowed.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway/webui && bun run test:unit -- src/services/calendar-api.test.ts src/components/calendar/calendar-view.test.tsx — PASS: 2 files, 11 tests
- **EV-002:** source scripts/env.sh && cd gateway/webui && bun run typecheck — PASS
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Calendar*' --tests '*PrivacyGuard*' — PASS: BUILD SUCCESSFUL
- **EV-004:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:compileDebugKotlin — PASS: BUILD SUCCESSFUL
- **EV-005:** source scripts/env.sh && cd gateway/webui && bun run test:unit -- src/services/calendar-api.integration.test.ts — PASS: 1 test
- **EV-006:** git diff --check 7f7cc7f912460ffe628a8b5842b2d87c3b9ce324..8bba3b8f8c792323a9f70d8fabdad7044ce22af6 — PASS: no whitespace errors

## Findings

- **CAL-V2-KMP-NULL-CHANGES** (high, open): CalendarChanges nullable clear fields are encoded with shared JSON configured as explicitNulls=false, so description/end/group/recurrence nulls are omitted instead of sent as JSON null. Mobile cannot issue the gateway's clear operations and silently sends a different command than web.
- **CAL-V2-KMP-CANCEL-PARSE** (low, open): runCatching wraps the suspending response parser and catches CancellationException, converting cancellation during parsing into AuthError.Unknown. The declared tests cover timeout but not cancellation.

## Verdict

fail

## Residual Risk

- The KMP compatibility surface still exposes legacy-shaped source fields such as more/baseEventId for unchanged platform callers; no wire fallback was observed.
- The web service exposes cursor support, but unchanged UI callers do not consume nextCursor.
