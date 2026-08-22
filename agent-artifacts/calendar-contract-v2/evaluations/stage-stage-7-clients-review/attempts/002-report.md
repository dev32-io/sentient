# Evaluation Report: stage-stage-7-clients-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Exact REST V2 parity across web and KMP
- No PATCH/DELETE or V1 wire fallback
- Source-level whole-series adapters preserve untouched UI compilation
- Calendar payload and token privacy in client diagnostics

## Observations

MERGE: YES
Re-review is limited to repair commit bd72b09b and its bounded tests. Both prior findings are resolved: CalendarPatch plus CalendarChangesSerializer now preserve omission, replacement, explicit JSON null clears, and empty tag-array clearing independently of explicitNulls=false; response parsing now rethrows CancellationException before generic mapping. Exact-wire and cancellation regressions pass, and all declared Stage 7 web/KMP checks pass. No repair-introduced regressions found.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway/webui && bun run test:unit -- src/services/calendar-api.test.ts src/components/calendar/calendar-view.test.tsx — PASS: 2 files, 11 tests
- **EV-002:** source scripts/env.sh && cd gateway/webui && bun run typecheck — PASS
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Calendar*' --tests '*PrivacyGuard*' --rerun-tasks — PASS: BUILD SUCCESSFUL
- **EV-004:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:compileDebugKotlin --rerun-tasks — PASS: BUILD SUCCESSFUL
- **EV-005:** git diff --check 8bba3b8f8c792323a9f70d8fabdad7044ce22af6..bd72b09b — PASS: no whitespace errors

## Findings

- **CAL-V2-KMP-NULL-CHANGES** (high, resolved): Tri-state patch encoding and exact-wire regressions close the explicit-clear defect.
- **CAL-V2-KMP-CANCEL-PARSE** (low, resolved): Cancellation is rethrown during response parsing and covered by regression test.

## Verdict

pass

## Residual Risk

None recorded.
