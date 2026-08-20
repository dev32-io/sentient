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

F7 is resolved: weekly BYDAY generation again uses Monday-anchored periods and the INTERVAL=2 regression probe produced the expected eligible weeks. F4 remains blocking at integration: the core now requires a resolved timezone, but the default server calendar handler still supplies the unresolved `household` sentinel to openCalendarStore. A focused probe created an all-day recurrence through that configuration and list returned `{ ok:false, error:'invalid' }`, so the repair has not threaded the resolved household timezone through every expansion path. All prescribed checks pass.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway && bun test src/calendar/types.test.ts src/calendar/calendar-temporal.test.ts src/calendar/expand-recurrence.test.ts src/calendar/recurrence-splitter.test.ts src/calendar/calendar-store.test.ts src/calendar/e2e-helpers.test.ts — 60 pass, 0 fail
- **EV-002:** source scripts/env.sh && cd shared/config && bun test src/schemas/orchestrator-config.test.ts — 10 pass, 0 fail
- **EV-003:** source scripts/env.sh && bun run typecheck — all workspaces exited 0
- **EV-004:** Focused closure probes — Monday-anchored INTERVAL=2 and configured Toronto split succeeded; default unresolved household-sentinel store path failed an all-day recurring list as invalid.
- **EV-005:** git diff --check 8350a63c407b5930338fb2c9cee12765b31a327d..d4672279ad258d1cff1e70f4e3efecaa25cf260d — clean

## Findings

- **F4** (high, open): Default server calendar handling still passes the unresolved household sentinel, so all-day recurring reads fail after the repair removed ambient fallback.

## Verdict

fail

## Residual Risk

- Closure-focused review inspected only F4/F7 repairs and their introduced integration effects.
