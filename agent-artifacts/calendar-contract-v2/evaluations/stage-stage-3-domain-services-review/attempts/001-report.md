# Evaluation Report: stage-stage-3-domain-services-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Complete-or-error model queries and deterministic bounded REST paging
- Effective-occurrence visibility and filter ordering
- Mutation authority, revisions, canonical recurrence, and whole-segment atomicity

## Observations

MERGE: NO

Three blocking Major findings remain in the bounded query service.

- STAGE3-001 (Major): `calendar-query.ts:377-387,398-413` stops at max-plus-one in private/household iteration order before global sorting. On overflow, REST can omit an earlier row from a later scope and subsequent cursors can never recover it, violating complete authorized aggregation and deterministic paging.
- STAGE3-002 (Major): `calendar-query.ts:403-407` lets tool mode return more than `query.pageSize` whenever the count remains below `maxOccurrences`. The equivalent REST query has a next page, so the tool contract requires `result_too_large`, not a successful complete array.
- STAGE3-003 (Major): `calendar-query.ts:353-368` and `calendar-store.ts:424` load all base IDs and scan/expand events without a candidate/work bound. Out-of-window, hidden, or filter-rejected events do not advance `maxOccurrences`, so a nominally bounded query can perform unbounded memory, SQL, and recurrence work.

Requirement conclusions:
- Effective override ordering, visibility, filtering, and partial-scope failure: covered and passing.
- Complete-or-error model queries and deterministic bounded REST paging: failed by STAGE3-001 through STAGE3-003.
- Mutation authority, canonical recurrence, revisions, and whole-segment atomicity: no blocking defect found; focused tests pass.

Checks: 15 focused tests passed; gateway typecheck passed; diff check passed. The focused tests do not cover the reported pagination/work-bound cases.

## Evidence

- **EV-001:** source scripts/env.sh && cd gateway && bun test src/calendar/calendar-query.test.ts src/calendar/calendar-mutations.test.ts src/calendar/nudge.test.ts — 15 pass, 0 fail
- **EV-002:** source scripts/env.sh && cd gateway && bun run typecheck — pass
- **EV-003:** source scripts/env.sh && bun /tmp/calendar-stage3-query-evidence.ts — Synthetic reproduction: tool returned 3 rows at pageSize 2; all-scope REST omitted the earliest household row across both returned pages.
- **EV-004:** git diff --check ca1dcec157993645830a4ec1f2ac825190721453..6daaa64cb4f51c6e6afc24e881d12e28b7fbbaf5 — pass

## Findings

- **STAGE3-001** (high, open): Pre-sort source-order overflow makes REST pages incomplete and permanently skips rows.
- **STAGE3-002** (high, open): Tool mode does not reject results that require REST pagination.
- **STAGE3-003** (high, open): Unbounded base-ID loading and scanning bypass configured work bounds.

## Verdict

fail

## Residual Risk

- Focused tests use small in-memory event sets and do not exercise large candidate populations or cross-scope overflow ordering.
