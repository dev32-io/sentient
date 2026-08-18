# Evaluation Report: stage-stage-5-bootstrap-nudge-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- orchestratorCfg.calendar config schema, config.yaml defaults, and old-config compatibility
- Capability minting, store open and close on session disposal, and prompt-cache stability preserved across an in-session write
- Nudge cap, deterministic drop order, empty-calendar omission, serving-tz rendering, and child/guest visibility

## Observations

MERGE: NO

Initial exhaustive review of d17670e01324e90f5add29a393ca5520cef8e57c found two blocking Major defects: household calendar tools are not wired into the session, and the nudge implementation violates its line cap and mandatory-item drop order. Required bootstrap, compatibility, lifecycle, and prompt-cache tests are also missing. Stage checks passed: typecheck and targeted tests (4 passed, 0 failed).

## Evidence

- **EV-001:** cd gateway && bun run typecheck — passed
- **EV-002:** cd gateway && bun test src/bootstrap/phase-services src/calendar/nudge — 4 passed, 0 failed
- **EV-003:** git diff --stat addf9bc06180eef45c5e452763a77b8bba4654fa d17670e01324e90f5add29a393ca5520cef8e57c — Bounded calendar bootstrap/config/nudge changes inspected without modifying the work.

## Findings

- **S5-BOOTSTRAP-001** (high, open): Only the private calendar store and calendar-private capability are supplied to the calendar provider; household scope requests are rejected and household-backed tools are unreachable.
- **S5-NUDGE-001** (high, open): The overflow marker is appended after line trimming, allowing maxLines to be exceeded; trimming can remove today or important/pinned items instead of dropping overflow/non-important weekly content first.
- **S5-VERIFY-001** (medium, open): The required boundary tests for calendar bootstrap capabilities/stores/close, household tool reachability, old-config compatibility, timezone resolution, and prompt-cache stability are absent; only two nudge tests and unrelated phase-service tests run in the assigned check.

## Verdict

fail

## Residual Risk

- The combined stage check does not exercise household tool reachability or nudge mandatory-item preservation under tight caps.
