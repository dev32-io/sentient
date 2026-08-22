# Evaluation Report: stage-stage-1-foundation-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Resource-class isolation and household path derivation
- Wire schema, isAdult predicate, UTC timestamp representation, and golden fixtures
- E2E scaffolding failure-safe cleanup and disposable-user isolation

## Observations

Iteration 2 review of 726eb41eba1fd63d09b3c524af1d7c6310d02a14: prescribed typecheck and focused tests pass (33/33). Resource isolation, cleanup scaffolding, malformed-RRULE rejection, and concrete body validation are satisfactory. One blocking schema defect remains: valid UNTIL recurrences are rejected because raw RFC UNTIL and wire ISO UNTIL formats are compared directly.

## Evidence

- **EV-001:** cd gateway && bun run typecheck — pass
- **EV-002:** cd gateway && bun test src/access src/calendar/types src/calendar/e2e-helpers — pass: 33 tests, 0 failures
- **EV-003:** Sanitized targeted wire-schema probe — false: valid bounded UNTIL recurrence rejected

## Findings

- **CAL-S1-004** (medium, open): Raw RFC UNTIL and wire ISO UNTIL formats are incompatible; valid UNTIL recurrence requests are rejected.

## Verdict

fail

## Residual Risk

- CalendarStore implementation and runtime close semantics are outside this stage and remain unverified.
- No final local-stack E2E is part of this stage boundary.
