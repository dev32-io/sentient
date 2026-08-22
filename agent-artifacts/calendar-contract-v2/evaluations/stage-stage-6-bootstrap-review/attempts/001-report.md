# Evaluation Report: stage-stage-6-bootstrap-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Immutable principal-to-capability authority and shared resolved configuration
- Session/REST lifecycle and close behavior
- Nudge security and bounds remain unchanged
- No automatic destructive reset or production mutation

## Observations

MERGE: NO
Focused checks pass (82 tests; workspace typecheck), and the composition root now shares frozen config/timezone and capability-held V2 stores across session/REST paths with idempotent session/request cleanup. However, the nudge refactor introduces a supported-config regression: its fixed ±10-day window is rejected by query.maxDays when configured below 21 days, causing valid today/weekly nudges to disappear. This violates the nudge behavior acceptance and blocks merge.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway && bun test src/bootstrap/phase-services.test.ts src/calendar/nudge.test.ts src/api/handlers/calendar.test.ts src/runtime/session-runtime.test.ts — 82 pass, 0 fail
- **EV-002:** source scripts/env.sh && bun run typecheck — All workspace typecheck targets passed
- **EV-003:** git diff --check ba7ad8d4f3a883930202ce86ebf8a77aa26ab3ea..529ddee04b74f825aa207b3bf634cd43133ddfbd — pass
- **EV-004:** Sanitized synthetic runtime evidence. — Valid today event with query.maxDays=1 produced nudge=null due to the fixed 21-day nudge query being rejected.

## Findings

- **STAGE6-001** (high, open): Fixed ±10-day nudge bounds exceed supported query.maxDays values below 21, so the bounded query fails and valid nudges disappear.

## Verdict

fail

## Residual Risk

- No additional blocking findings observed within the stage boundary. The focused suite does not cover low query.maxDays nudge configurations; the synthetic reproduction is recorded at /tmp/calendar-bootstrap-review-nudge.txt.
