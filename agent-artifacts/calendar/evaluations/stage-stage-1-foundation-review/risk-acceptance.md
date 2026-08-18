# Risk acceptance — stage-stage-1-foundation-review

- Work item: calendar
- Evaluation: stage-stage-1-foundation-review
- Reviewed commit: d5e2805aa5c3d60bb0276b35b524a4f84756054e
- Decision: Approved with risk
- Recorded at: 2026-08-18T00:45:48.832Z

## Accepted findings

### CAL-S1-005 — medium
- Location: gateway/src/calendar/types.ts:138-145, 283-305
- Summary: Impossible RRULE UNTIL timestamps and invalid all-day dates are accepted.
- Manager rationale: Medium (non-critical) boundary-validation gap: localDate (types.ts:140-143) and parseRRule UNTIL (types.ts:297) regexes accept impossible calendar values (e.g. month 13, Feb 31, hour 25). The automatic review/fix loop is exhausted at 3/3 iterations and already resolved four prior medium findings (CAL-S1-001..004); per workflow-run point 7, stop chasing newly discovered non-critical issues and preserve as residual risk. The fix is narrow and well-understood (shared isValidCalendarDate round-trip check for localDate + UNTIL) and does not block downstream stages: it can be applied in a focused follow-up or caught by final-branch-review. Stage-1 functional contract is otherwise satisfied (typecheck + 33/33 focused tests pass; resource-class isolation, wire schema, isAdult, UTC representation, and E2E scaffolding all verified).
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: stage-stage-1-foundation-review
recordedAt: 2026-08-18T00:20:00.502Z
entries:
  - result: pass
    command: cd gateway && bun run typecheck
  - result: "pass: 33 tests, 0 failures"
    command: cd gateway && bun test src/access src/calendar/types
      src/calendar/e2e-helpers
  - result: invalidUntil returned ok:true; invalidDate returned true
    command: cd gateway && bun -e 'import {parseRRule,wireCalendarTimeSchema} from
      "./src/calendar/types.ts";
      console.log(JSON.stringify({invalidUntil:parseRRule("FREQ=DAILY;UNTIL=20261399T256199Z"),invalidDate:wireCalendarTimeSchema.safeParse({kind:"all-day",date:"2026-99-99"}).success}))'
    description: Sanitized targeted date-validation probes
    path: files/3-types.ts
    checksum: sha256:a4c2bc3d7f039a2bd1f783b5dce47f5e9032fae7efd96d84533bdb12f7a3fe05

## Residual risks

- CAL-S1-005: Impossible RRULE UNTIL timestamps and invalid all-day dates are accepted.

## Provenance

Canonical evaluation report: evaluations/stage-stage-1-foundation-review/evaluation.yaml
Evidence resource: evidence/stage-stage-1-foundation-review/manifest.yaml
