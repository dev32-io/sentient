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

Six Major defects block the stage: weekly BYDAY slots are generated out of order; fractional recurring DTSTART identity is lost; all-day UNTIL splitting throws; recurrence date-period UNTIL ignores the household timezone; malformed persisted timestamps are trusted; and the hard-coded 256-character query schema defeats the configured 512-character bound. All prescribed stage checks and diff hygiene passed, but focused sanitized probes reproduce the recurrence and persistence failures.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway && bun test src/calendar/types.test.ts src/calendar/calendar-temporal.test.ts src/calendar/expand-recurrence.test.ts src/calendar/recurrence-splitter.test.ts src/calendar/calendar-store.test.ts src/calendar/e2e-helpers.test.ts — 52 pass, 0 fail
- **EV-002:** source scripts/env.sh && cd shared/config && bun test src/schemas/orchestrator-config.test.ts — 10 pass, 0 fail
- **EV-003:** source scripts/env.sh && bun run typecheck — all workspaces exited 0
- **EV-004:** Focused Bun probes against recurrence and persistence boundaries — Reproduced nonchronological MO/SU COUNT slots, omitted fractional DTSTART, thrown all-day UNTIL split, and acceptance of malformed persisted timestamps.
- **EV-005:** git diff --check 49c71459bbb10b760e2a1b1c60178b69806d7ade..4b0091951b0fe148bec0657a17c68b03aed255ca — clean

## Findings

- **F1** (high, open): Sunday-based sorting emits Sunday before Monday in a Monday-anchored week, producing nonchronological and incorrectly ordinaled BYDAY slots.
- **F2** (high, open): Fractional seconds are dropped from the recurrence wall-clock anchor, omitting a fractional DTSTART and changing later originalStart keys.
- **F3** (high, open): All-day prefix terminal text is cast as an ISO instant and reparsed as Invalid Date, causing splitRecurrence to throw.
- **F4** (high, open): Structured recurrence date-period UNTIL is canonicalized at UTC end-of-period with no household/event timezone input.
- **F5** (high, open): created_at and updated_at are validated only as non-empty strings and malformed values are returned as trusted UtcInstant fields.
- **F6** (high, open): A hard-coded schema maximum of 256 rejects valid configured query lengths from 257 through 512.

## Verdict

fail

## Residual Risk

None recorded.
