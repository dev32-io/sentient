# Evaluation Report: final-e2e

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: YES_WITH_RISK
Closure-focused re-review of the bounded repair (e1f69d09, included in reviewed commit 7f8be724) found all four manager-directed final-E2E defects resolved with no repair-introduced regressions. Fresh local-stack evidence showed: the live agent adults-only create carried visibility=adults through the permission flow and was hidden from child list/UI/nudge; household-sentinel recurring events listed successfully with the sentinel preserved; capped nudges retained important weekly entries while trimming normal overflow and only applying last-resort mandatory trimming when necessary; and the web calendar produced zero additional calendar requests during a three-second observation. Gateway typecheck and targeted calendar tests passed (13/13); webui unit tests passed (143/143) and typecheck passed. CAL-E2E-005 remains an accepted, non-blocking residual per the manager decision: the covering recurrence query is correct, while the current-week view shows only occurrences in the current week. No new blocking findings were identified.

## Evidence

- **EV-001:** cat /tmp/calendar-e2e-rereview-20260818/evidence-summary.json — Sanitized fresh closure evidence for the four repaired defects, checks, and cleanup.
- **EV-002:** cd gateway && bun run typecheck — Passed.
- **EV-003:** cd gateway && bun test src/calendar/nudge src/bootstrap/product-tools/calendar-provider src/api/handlers/calendar — 13 passed, 0 failed.
- **EV-004:** cd gateway/webui && bun run test:unit && bun run typecheck — 143 unit tests passed; typecheck passed.
- **EV-005:** git status --short --branch && git diff --check — Reviewed branch clean; evaluated product code was not modified.

## Findings

- **CAL-E2E-001** (critical, resolved): Tool field schemas now expose visibility and the live adults-only create preserved the field; child surfaces omitted the event.
- **CAL-E2E-002** (high, resolved): Household timezone sentinel recurrence now lists and expands successfully without 422.
- **CAL-E2E-003** (high, resolved): Nudge trimming now preserves important weekly entries and uses normal overflow first, with mandatory trimming only as a last resort.
- **CAL-E2E-004** (high, resolved): CalendarApi identity is stable; fresh route observation showed no repeated fetch loop.
- **CAL-E2E-005** (high, accepted): Accepted residual matrix wording mismatch; not reopened per manager guidance.

## Verdict

pass

## Residual Risk

- CAL-E2E-005: the persisted matrix wording says the COUNT=10 recurrence should render all 10 in the week view, but the implementation intentionally displays the current seven-day window; this was explicitly accepted by the manager and not reopened.
