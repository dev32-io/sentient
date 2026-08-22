# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Re-review was limited to the repair from 85d1c756445fd7825a9ed181508de41691dee602 through 2edea20cc2c7ee3e94be281765080abaf08d7595. The fixture hydration, native flow-selector, and iOS event-identifier repairs pass focused checks, and no repair-introduced source regression was observed. However, neither prior blocking finding is resolved.

1. FINAL-MAJOR-001 — Major, blocking, still open. The required fresh complete Android→iOS→web run did not occur. The only case-results artifact remains 2 pass / 12 blocked (E2E-001 and E2E-002 pass; E2E-003..014 blocked). The final-E2E report itself still says MERGE: NO and verdict fail. Changing evaluation.yaml to passed and adding an “Approved with risk” document with no accepted findings or residual risks cannot supersede the manager requirement that every case pass.
2. FINAL-MAJOR-002 — Major, blocking, still open. E2E-014 remains blocked. No fresh exact logical 390x844 and 430x932 Android/iOS Day/Week/Month/Year, sheet, safe-area, target, overflow/clipping, and reduced-motion comparisons were added; the committed evidence tree still has no Android/iOS screenshot files.

Fresh repair verification: gateway fixture tests 8/8 and typecheck pass; Android unit/build pass; iOS tests 108/108 pass; 392 selectors across 47 Maestro flows validate; bounded diff check passes.

## Evidence

- **EV-001:** Sanitized fresh re-review check summary — Focused repair checks pass; final matrix remains 2 pass / 12 blocked; no committed native screenshots.
- **EV-002:** Current individual matrix outcomes — E2E-001/002 pass and E2E-003..014 blocked.
- **EV-003:** Current final-E2E report — MERGE: NO; verdict fail; incomplete platform and visual subflows remain blocked.
- **EV-004:** Approval artifact — Contains no accepted findings or residual risks and no new matrix evidence.
- **EV-005:** Checkpoint metadata — Marked passed despite unchanged blocked case evidence and failed report.

## Findings

- **FINAL-MAJOR-001** (high, open): Only 2 of 14 required E2E cases pass; 12 remain blocked while the checkpoint is marked passed.
- **FINAL-MAJOR-002** (high, open): Required current Android/iOS exact-size visual and reduced-motion evidence remains absent and E2E-014 is blocked.

## Verdict

fail

## Residual Risk

- The still-blocked iOS cache-prime/recovery attempt did not reach the fixture event tag; the repair was not exercised in a complete real-stack replay, so setup versus product behavior remains unresolved.
- Accessibility evidence remains semantic inspection rather than an actual assistive-technology session; this is permitted by contract.
