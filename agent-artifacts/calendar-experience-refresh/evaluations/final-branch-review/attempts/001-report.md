# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Fresh source checks pass: web 230 tests/typecheck/build; shared mobile-data/mobile-sdk and Android unit/build gates; gateway fixture tests/typecheck; iOS 107 tests; flow static validation; and diff check.

Major findings:
1. FINAL-MAJOR-001 — Blocking. The required exact 14-case real-local-stack matrix is incomplete. The final record has only E2E-001 and E2E-002 passing; E2E-003 through E2E-014 are blocked. This leaves core cross-platform acceptance unverified, including filters, mutations, recurrence/conflicts, permissions, mobile offline/recovery/isolation, temporal behavior, and accessibility. The final-e2e checkpoint's pass status conflicts with both its own evidence and the manager instruction to rerun the complete matrix.
2. FINAL-MAJOR-002 — Blocking. AC-014 visual proof is incomplete. E2E-014 is blocked, explicitly states the complete native visual/reduced-motion replay was not repeated, and no Android/iOS screenshots at logical 390x844 and 430x932 are present in the committed evidence tree. Exact native handoff, overlay/safe-area geometry, and reduced-motion conformance therefore remain unaccepted.

Requirement conclusion: static/unit/build boundaries are healthy, but the required final behavioral and visual acceptance gates are unmet, so the reviewed commit cannot merge.

## Evidence

- **EV-001:** Sanitized fresh verification summary — All static/unit/build checks passed; matrix count is 2 pass, 12 blocked.
- **EV-002:** Individual final E2E case outcomes — E2E-001/002 pass; E2E-003..014 blocked.
- **EV-003:** Required checkpoint state and manager instruction — Checkpoint marked passed despite instruction to rerun the complete 14-case matrix.
- **EV-004:** Final E2E report — Records iOS recovery gap and multiple blocked subflows.

## Findings

- **FINAL-MAJOR-001** (high, open): Only 2 of 14 required E2E cases pass; 12 are blocked while the checkpoint is marked passed.
- **FINAL-MAJOR-002** (high, open): Current required Android/iOS exact-size visual and reduced-motion evidence is absent and E2E-014 is blocked.

## Verdict

fail

## Residual Risk

- The blocked iOS cache-prime/recovery attempt did not reach the fixture event tag; without a completed replay it is unclear whether this is fixture setup or a product defect.
- Accessibility evidence remains semantic/keyboard inspection rather than an actual assistive-technology session, which is permitted but remains residual risk.
