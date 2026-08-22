# Outcome: Model-friendly bounded calendar contracts and recurring mutations

## Delivered

- All six model-facing calendar tools now use concise V2 temporal strings, structured recurrence, private-by-default scope, explicit recurring mutation scope, bounded complete-or-error results, actionable errors, and preserved authorization/tier gates.
- A shared revisioned calendar domain now provides bounded effective-occurrence queries, deterministic REST paging, optimistic concurrency, canonical single-occurrence overrides/cancellation, and atomic Google-style this-and-following series splits for COUNT and UNTIL recurrence.
- Fresh capability-isolated V2 SQLite storage uses <cap.rootPath>/calendar-v2/calendar.db; legacy calendar data is neither migrated nor automatically deleted.
- REST, web service, KMP SDK, and mobile-data now share the V2 mutation contract; PATCH/DELETE mutation routes and legacy wire paging/recurrence shapes were removed while existing UI source remains unchanged.
- Operator configuration now bounds temporal ranges, aggregate occurrences, paging, input fields, recurrence, nudge volume, and proactive model output below the generic broker cap; diagnostics remain content-free.
- User-authorized workflow configuration increased repairRounds from 3 to 6.

## Verification

- stage-stage-1-contracts-review: passed
- stage-stage-2-foundations-review: passed (risk report: risk-acceptance.md)
- stage-stage-3-domain-services-review: passed
- stage-stage-4-recurring-mutations-review: passed
- stage-stage-5-gateway-adapters-review: passed
- stage-stage-6-bootstrap-review: passed
- stage-stage-7-clients-review: passed
- stage-stage-8-mobile-data-review: passed
- final-e2e: passed
- final-branch-review: passed (risk report: risk-acceptance.md)

## Contract Deviations

- A failed managed Stage 8 fixer left valid uncommitted recovery work; with explicit user authorization it was completed, verified, and committed manually before the evaluation was recorded.
- The final review's UI-change finding was rejected because the cited UI files predated this work item; the work-item diff contains no web, Android, or iOS calendar UI/ViewModel changes.
- A deprecated source-only KMP CalendarEvent.baseEventId compatibility member remains for unchanged platform source. It is not serializable, never populated from V2 responses, and is not used for V2 identity or mutation routing.

## Remaining Findings

- **F4** (high, accepted; stage-stage-2-foundations-review): Default server calendar handling still passes the unresolved household sentinel, so all-day recurring reads fail after the repair removed ambient fallback.
- **CAL-V2-FINAL-003** (high, accepted; final-branch-review): Deprecated baseEventId remains exported on CalendarEvent, so the explicit V1-field removal requirement is unmet.

## Residual Risks

- The deprecated source-only baseEventId compatibility member should be removed during the planned calendar UI refresh; no V1 baseEventId or more field remains on the wire.
- This is a clean storage cutover: existing V1 calendar databases are intentionally ignored, so operators must treat prior calendar state as disposable as agreed.
- PiBox retained 35 task worktrees for inspection or later cleanup.

## Follow-up

- Use `/harness worktrees` to inspect or safely clean inactive retained worktrees.
- Review the completed feature/calendar branch and proceed with the normal Git/PR/merge process.
- Remove the source-only baseEventId compatibility view when the deferred web/mobile calendar UI refresh updates platform callers.
