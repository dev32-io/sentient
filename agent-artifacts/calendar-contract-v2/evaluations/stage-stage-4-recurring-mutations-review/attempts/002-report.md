# Evaluation Report: stage-stage-4-recurring-mutations-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Rich single-occurrence override and canonical cancellation invariants
- COUNT and UNTIL split arithmetic including excluded/cancelled slots and DST
- Exception/exclusion partitioning, recurrence conflicts, first-slot behavior, and atomic rollback
- No duplicate, missing, or cross-segment occurrence ownership

## Observations

All three prior findings are repaired in the bounded diff: successor timing propagates across later slots with correct duration, effective adults-only targets are hidden from child mutations, and cancelled/excluded split targets are rejected before transaction. Focused checks pass. Merge remains blocked by one repair-path AC-008 defect: a backward successor re-anchor is not checked against retained prefix ownership, so both persisted segments can own the same originalStart and displayed slot.

## Evidence

- **EV-001:** focused stage bun test — 65 pass, 0 fail
- **EV-002:** gateway typecheck — pass
- **EV-003:** prior-finding runtime probes — Timing propagation is corrected; hidden and cancelled targets return occurrence_not_found.
- **EV-004:** backward re-anchor runtime probe — Mutation succeeded while prefix and successor each produced the same 2026-01-06 originalStart/time.

## Findings

- **S4-004** (high, open): Backward successor re-anchoring can overlap a retained prefix slot, creating duplicate cross-segment occurrence ownership.

## Verdict

fail

## Residual Risk

- The new tests cover forward re-anchoring but not backward anchors that intersect the unchanged prefix.
