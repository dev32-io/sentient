# Evaluation Report: stage-stage-4-recurring-mutations-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Rich single-occurrence override and canonical cancellation invariants
- COUNT and UNTIL split arithmetic including excluded/cancelled slots and DST
- Exception/exclusion partitioning, recurrence conflicts, first-slot behavior, and atomic rollback
- No duplicate, missing, or cross-segment occurrence ownership

## Observations

Stage checks pass (62 focused tests; typecheck; diff check), and the implementation preserves COUNT/UNTIL partition arithmetic, canonical single cancellation, first-slot deletion/replacement, and transaction rollback in the covered cases. Merge is blocked by three Major acceptance defects: successor timing changes do not apply to future occurrences, effective selected-occurrence visibility is not enforced for this_and_following update, and cancelled/unavailable targets are accepted by that update path.

## Evidence

- **EV-001:** focused stage bun test — 62 pass, 0 fail
- **EV-002:** gateway typecheck — pass
- **EV-003:** runtime timing and visibility probe — Successor timing remained on the old schedule for future slots; child mutation of an adults-only overridden slot succeeded.
- **EV-004:** runtime unavailable-target probe — Following update on a cancelled slot succeeded and created a successor.

## Findings

- **S4-001** (high, open): this_and_following start/end changes do not re-anchor successor timing for all following occurrences.
- **S4-002** (high, open): this_and_following update permits a child to mutate an adults-only effective occurrence.
- **S4-003** (high, open): this_and_following update accepts a cancelled selected occurrence and creates a successor.

## Verdict

fail

## Residual Risk

- Focused tests do not cover changed successor timing across future slots or effective-visibility authorization for this_and_following updates, allowing these regressions to pass.
