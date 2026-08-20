# Evaluation Report: stage-stage-2-foundations-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Temporal and recurrence correctness including DST and generated-slot identity
- Fresh V2 storage isolation, capability gates, revision CAS, and rollback primitives
- Operator limits remain bounded below the generic result cap
- Parallel contributions have non-overlapping source ownership and coherent contracts

## Observations

MERGE: NO

Re-review of repair commit b08680c0 at reviewed commit 8350a63c: F2, F3, F5, and F6 are resolved; F1's simple Sunday/Monday ordering case is fixed, but the repair introduces a blocking INTERVAL regression (F7); F4 remains open because all-day structured successor UNTIL normalization still falls back to the host timezone rather than receiving configured household timezone. All prescribed checks pass.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway && bun test src/calendar/types.test.ts src/calendar/calendar-temporal.test.ts src/calendar/expand-recurrence.test.ts src/calendar/recurrence-splitter.test.ts src/calendar/calendar-store.test.ts src/calendar/e2e-helpers.test.ts — 58 pass, 0 fail
- **EV-002:** source scripts/env.sh && cd shared/config && bun test src/schemas/orchestrator-config.test.ts — 10 pass, 0 fail
- **EV-003:** source scripts/env.sh && bun run typecheck — all workspaces exited 0
- **EV-004:** Focused repair probes — Confirmed F2/F3 repairs; INTERVAL=2 weekly slots used rolling DTSTART windows; all-day changed successor UNTIL used host-zone terminal instead of explicit configured-zone terminal.
- **EV-005:** git diff --check 4b009195..8350a63c — clean

## Findings

- **F4** (high, open): UNTIL normalization still has an ambient host-timezone fallback, and all-day structured successor splits cannot receive the configured household timezone.
- **F7** (high, open): Repair changed weekly periods from Monday-anchored RRULE weeks to rolling DTSTART-day windows, causing INTERVAL>1 BYDAY series to generate slots in skipped weeks.

## Verdict

fail

## Residual Risk

- No broader implementation was reopened during this closure-focused re-review.
