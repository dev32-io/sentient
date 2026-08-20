# Risk acceptance — stage-stage-2-foundations-review

- Work item: calendar-contract-v2
- Evaluation: stage-stage-2-foundations-review
- Reviewed commit: d4672279ad258d1cff1e70f4e3efecaa25cf260d
- Decision: Approved with risk
- Recorded at: 2026-08-20T02:39:43.825Z

## Accepted findings

### F4 — high
- Location: gateway/src/api/handlers/calendar.ts:22-38,96-102; gateway/src/calendar/calendar-store.ts:439-446,506-508
- Summary: Default server calendar handling still passes the unresolved household sentinel, so all-day recurring reads fail after the repair removed ambient fallback.
- Manager rationale: This is a temporary composition gap, not a remaining foundation-algorithm defect. The reviewed plan explicitly assigns resolution of the household sentinel and threading the concrete timezone through REST/session factories to task calendar-v2-bootstrap in stage 6. Accepting it here avoids pulling later composition work into the foundation stage while preserving a blocking verification obligation for stage 6 and final E2E. No ambient fallback is accepted.
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: stage-stage-2-foundations-review
recordedAt: 2026-08-20T02:39:12.518Z
entries:
  - result: 60 pass, 0 fail
    command: source scripts/env.sh && cd gateway && bun test
      src/calendar/types.test.ts src/calendar/calendar-temporal.test.ts
      src/calendar/expand-recurrence.test.ts
      src/calendar/recurrence-splitter.test.ts
      src/calendar/calendar-store.test.ts src/calendar/e2e-helpers.test.ts
    path: files/1-stage2-rereview2-gateway.txt
    checksum: sha256:b56f18d55060d52ca5284b2a184de506f9ad77b78a5edff4b1a9cd23257929e9
  - result: 10 pass, 0 fail
    command: source scripts/env.sh && cd shared/config && bun test
      src/schemas/orchestrator-config.test.ts
    path: files/2-stage2-rereview2-config.txt
    checksum: sha256:0f44f35f94f60334fb1167653754e09fb006f2deed4d3aba62bb88706f52a8c0
  - result: all workspaces exited 0
    command: source scripts/env.sh && bun run typecheck
    path: files/3-stage2-rereview2-typecheck.txt
    checksum: sha256:7b04fd59923a17aa51136f349a76fc1e5b4ac9f0a331db200ab8f260e8a71d73
  - result: Monday-anchored INTERVAL=2 and configured Toronto split succeeded;
      default unresolved household-sentinel store path failed an all-day
      recurring list as invalid.
    command: Focused closure probes
    path: files/4-stage2-rereview2-probes.txt
    checksum: sha256:dcfeee1094530db72c326d9e004af4514e0f0bd54429b162411cb7981cc4961b
  - result: clean
    command: git diff --check
      8350a63c407b5930338fb2c9cee12765b31a327d..d4672279ad258d1cff1e70f4e3efecaa25cf260d

## Residual risks

- F4: Default server calendar handling still passes the unresolved household sentinel, so all-day recurring reads fail after the repair removed ambient fallback.

## Provenance

Canonical evaluation report: evaluations/stage-stage-2-foundations-review/evaluation.yaml
Evidence resource: evidence/stage-stage-2-foundations-review/manifest.yaml
