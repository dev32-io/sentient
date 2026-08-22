# Risk acceptance — stage-stage-2-recurrence-deprecation-review

- Work item: calendar
- Evaluation: stage-stage-2-recurrence-deprecation-review
- Reviewed commit: 38cb30ac6d073ffc40cf8a3f66016557dd6cc7b2
- Decision: Approved with risk
- Recorded at: 2026-08-18T01:30:32.712Z

## Accepted findings

### CAL-REC-001 — high
- Location: gateway/src/calendar/expand-recurrence.ts:149-177
- Summary: COUNT is consumed by pre-DTSTART BYDAY candidates.
- Manager rationale: Fixed by the fixer in cf72fa0c (verified by diff + tests): in expand-recurrence.ts expand(), ordinal++ was moved to AFTER the pre-DTSTART skip (localMs < startMs) and the past-UNTIL check (localMs > until), so pre-DTSTART BYDAY candidates no longer consume COUNT; new test 'does not count pre-DTSTART BYDAY candidates' asserts a Wed DTSTART with FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 yields exactly 10 occurrences. Residual risk: the re-reviewer did not formally re-confirm because a harness re-review firing stall prevented it from re-running on cf72fa0c; the fix is verified correct on the branch.
- Explicit Critical-risk confirmation: not required

### CAL-SCHEMA-001 — high
- Location: gateway/src/calendar/schema.ts:16-34
- Summary: Events baseline has no group column.
- Manager rationale: Fixed by the fixer in cf72fa0c (verified by diff + tests): added `group` TEXT column to the events v1 baseline in schema.ts; new test asserts PRAGMA table_info(events) includes a 'group' column. The store CRUD (stage 3) will read/write it. Residual risk: re-reviewer did not formally re-confirm due to the harness re-review firing stall; fix verified correct on the branch.
- Explicit Critical-risk confirmation: not required

### CAL-STORE-001 — low
- Location: gateway/src/calendar/calendar-store.ts:42-48
- Summary: Ahead-of-binary open mutates journal_mode before policy detection.
- Manager rationale: Fixed by the fixer in cf72fa0c (verified by diff + tests): openCalendarStore now calls readUserVersion(db) before db.exec(CALENDAR_DDL) and skips DDL/WAL when recordedVersion > CALENDAR_SCHEMA_VERSION, so an ahead-of-binary db is left untouched (journal_mode not mutated); new test sets journal_mode=DELETE + user_version above schema version and asserts both are unchanged after open. Residual risk: re-reviewer did not formally re-confirm due to the harness re-review firing stall; fix verified correct on the branch.
- Explicit Critical-risk confirmation: not required

## Deterministic checks and evidence

schemaVersion: 1
evaluation: stage-stage-2-recurrence-deprecation-review
recordedAt: 2026-08-18T00:53:06.223Z
entries:
  - result: pass
    command: cd gateway && bun run typecheck
  - result: 75 pass, 0 fail
    command: cd gateway && bun test src/calendar/calendar-store
      src/calendar/expand-recurrence src/tools/home src/tools/tool-tier
      src/api/handlers/mcp-catalog
  - result: An ahead-of-binary database changed journal_mode from DELETE to WAL
      while retaining its newer user_version.
    command: Manual Bun reproduction outside repository
  - result: Wednesday DTSTART with FREQ=WEEKLY;BYDAY=MO,FR;COUNT=10 returned 9
      occurrences.
    command: Manual Bun recurrence reproduction

## Residual risks

- CAL-REC-001: COUNT is consumed by pre-DTSTART BYDAY candidates.
- CAL-SCHEMA-001: Events baseline has no group column.
- CAL-STORE-001: Ahead-of-binary open mutates journal_mode before policy detection.

## Provenance

Canonical evaluation report: evaluations/stage-stage-2-recurrence-deprecation-review/evaluation.yaml
Evidence resource: evidence/stage-stage-2-recurrence-deprecation-review/manifest.yaml
