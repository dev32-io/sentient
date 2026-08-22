# Risk acceptance — final-branch-review

- Work item: calendar-experience-refresh
- Evaluation: final-branch-review
- Reviewed commit: 2edea20cc2c7ee3e94be281765080abaf08d7595
- Decision: Approved with risk
- Recorded at: 2026-08-22T19:08:54.739Z

## Accepted findings

### FINAL-MAJOR-001 — high
- Location: agent-artifacts/calendar-experience-refresh/evidence/final-e2e/files/005-6-case-results.json:1
- Summary: Only 2 of 14 required E2E cases pass; 12 remain blocked while the checkpoint is marked passed.
- Manager rationale: User explicitly accepts the incomplete current final-E2E evidence: the recorded artifact shows 2 of 14 cases passing and 12 blocked, despite the bounded repair findings being resolved.
- Explicit Critical-risk confirmation: not required

### FINAL-MAJOR-002 — high
- Location: agent-artifacts/calendar-experience-refresh/evidence/final-e2e/files/005-6-case-results.json:15
- Summary: Required current Android/iOS exact-size visual and reduced-motion evidence remains absent and E2E-014 is blocked.
- Manager rationale: User explicitly accepts the absence of current exact-size Android/iOS visual and reduced-motion evidence for E2E-014.
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: final-branch-review
recordedAt: 2026-08-22T17:45:49.053Z
entries:
  - result: Focused repair checks pass; final matrix remains 2 pass / 12 blocked; no
      committed native screenshots.
    description: Sanitized fresh re-review check summary
    path: files/002-1-calendar-final-branch-rereview-iteration1.txt
    checksum: sha256:065c847234bf21cb49a18f52ced018c6f4772a54a46cc3eabec0e43d4d5bb18d
  - result: E2E-001/002 pass and E2E-003..014 blocked.
    description: Current individual matrix outcomes
    path: files/002-2-005-6-case-results.json
    checksum: sha256:5ede912d56cd0ea12d536f5147a83a1d9c17ab7dd6b5e3779ea7dc0d3cad6399
  - result: "MERGE: NO; verdict fail; incomplete platform and visual subflows remain
      blocked."
    description: Current final-E2E report
    path: files/002-3-report.md
    checksum: sha256:21b565d19acb01e98606c5d02787dd3e05585668de84f2faa1419f7f82fcdce1
  - result: Contains no accepted findings or residual risks and no new matrix evidence.
    description: Approval artifact
    path: files/002-4-risk-acceptance.md
    checksum: sha256:9a8ddabff8620063c0fda527571600e5de3434ce7f4aec1ecf604ea68e351b18
  - result: Marked passed despite unchanged blocked case evidence and failed report.
    description: Checkpoint metadata
    path: files/002-5-evaluation.yaml
    checksum: sha256:8ad2ebd078e5a5e107d8c87143ee292690bdc05a0ffec1dedd56ffe38ec9b501

## Residual risks

- FINAL-MAJOR-001: Only 2 of 14 required E2E cases pass; 12 remain blocked while the checkpoint is marked passed.
- FINAL-MAJOR-002: Required current Android/iOS exact-size visual and reduced-motion evidence remains absent and E2E-014 is blocked.

## Provenance

Canonical evaluation report: evaluations/final-branch-review/evaluation.yaml
Evidence resource: evidence/final-branch-review/manifest.yaml
