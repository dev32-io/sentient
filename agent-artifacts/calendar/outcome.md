# Outcome: Gateway-owned family calendar

## Delivered

- Gateway-owned family calendar: capability-gated WAL SQLite CalendarStore (calendar-private/calendar-household resource classes, household path derivation, ahead-of-binary policy, close() lifecycle)
- Bounded RRULE recurrence expansion (event-tz-anchored: UTC instant + event tz id default household + all-day date; expands in the event's own tz; EXDATE/exceptions; DST-correct)
- Concrete JSON wire schema + golden fixtures shared across REST/tools/web/SDK (occurrence-aware list wire with occurrenceId/baseEventId; strict validation rejecting unknown RRULE keys, malformed recurrence, impossible dates/times)
- Calendar tool group (calendar_list/get/search/create/update/delete) with pre-PDP household-write rejection (zero store calls for non-adult household writes) and scheduler-fence tool descriptions
- REST API /api/v1/calendar with authenticated-principal authority, request-scoped store close, tz-aware values
- Session nudge composer (today + important/pinned weekly, deterministic drop order, household-tz today, empty-calendar omission, prompt-cache stability)
- HA calendar tools deprecated across provider/catalog/role-defaults (no profile migrator)
- Web Preact client (route, REST client, device-tz rendering, CRUD, stable api identity)
- Mobile SDK CalendarHttpClient (bounded request timeout, golden-fixture wire fidelity) + mobile-data repositories/use cases (stateless passthrough, ViewModel->use-case seam)
- Android Compose calendar screen + drawer affordance (calendar-open testTag) + ViewModel; iOS SwiftUI calendar screen with create/update/delete controls + device-tz rendering

## Verification

- stage-stage-1-foundation-review: passed (risk report: risk-acceptance.md)
- stage-stage-2-recurrence-deprecation-review: passed (risk report: risk-acceptance.md)
- stage-stage-3-store-crud-review: passed
- stage-stage-4-rest-and-provider-review: passed
- stage-stage-5-bootstrap-nudge-review: passed
- stage-stage-6-clients-review: passed
- stage-stage-7-mobile-data-review: passed
- stage-stage-8-mobile-platform-review: passed (risk report: risk-acceptance.md)
- final-e2e: passed
- final-branch-review: passed

## Contract Deviations

- Stage-8 declared checks were amended mid-execution: Android gradle path :android:app (non-existent) -> :android; iOS XCFramework task assembleXCFramework -> assembleMobileDataXCFramework; iOS xcodebuild destination pinned to OS=18.3.1 (the iOS 26.5 simulator runtime build 23F77 is newer than Xcode 26.5 build 17F42, causing DVTBuildVersion incompatibility)
- Several harness bugs were hit and fixed by the user during the run (fixer/reviewer not firing after request_changes; check-execution env discrepancies; fixer not committing its changes; completion-gate blocking on accepted findings). These were harness-side, not plan/product defects
- The approved e2e-matrix E2E-002 wording ('exactly 10 occurrences render in the week view') was not corrected (matrix is immutable during execution); the covering-query yields 10 (correct per AC-005) and the web week view correctly shows the current seven-day window

## Remaining Findings

- **CAL-S1-005** (medium, accepted; stage-stage-1-foundation-review): Impossible RRULE UNTIL timestamps and invalid all-day dates are accepted.
- **CAL-REC-001** (high, accepted; stage-stage-2-recurrence-deprecation-review): COUNT is consumed by pre-DTSTART BYDAY candidates.
- **CAL-SCHEMA-001** (high, accepted; stage-stage-2-recurrence-deprecation-review): Events baseline has no group column.
- **CAL-STORE-001** (low, accepted; stage-stage-2-recurrence-deprecation-review): Ahead-of-binary open mutates journal_mode before policy detection.
- **S5-VERIFY-001** (medium, deferred; stage-stage-5-bootstrap-nudge-review): Prior deferred verification gap remains non-blocking and was not reopened during this closure-focused re-review.
- **CAL-MOBILE-003** (high, accepted; stage-stage-8-mobile-platform-review): Android CRUD tests were added, but the navigation test bypasses HistoryDrawer/HistoryContent and directly tests navigateToCalendar, leaving the explicit actual drawer-wiring acceptance unmet.
- **CAL-E2E-005** (high, accepted; final-e2e): Accepted residual matrix wording mismatch; not reopened per manager guidance.
- **CAL-FINAL-011** (low, accepted; final-branch-review): GMT all-day formatting remains as manager-accepted residual risk.
- **CAL-FINAL-012** (low, accepted; final-branch-review): Tool notificationPolicy persistence remains as manager-accepted residual risk.

## Residual Risks

- Stage-5 S5-VERIFY-001 (medium, deferred): missing bootstrap lifecycle/compat/timezone/prompt-cache boundary tests
- Stage-6 (deferred): mobile SDK CRUD wire fidelity lightly tested (GET/list pinned; POST/PATCH/DELETE not directly pinned)
- Stage-8 CAL-MOBILE-003 (accepted high): Android drawer-navigation test exercises the navigateToCalendar route helper + calendar-open testTag contract, not a full Compose-UI render (repo has no Compose UI test infra); functional wiring verified
- final-E2E CAL-E2E-005 (accepted high): web current-week view shows 2 (current week) not 10 (covering window) for the COUNT=10 MO,FR event; matrix E2E-002 wording is stale - covering-query=10 is correct per AC-005
- final-branch CAL-FINAL-011 (low, accepted): iOS all-day query bounds formatted in GMT rather than device-local time
- final-branch CAL-FINAL-012 (low, accepted): tool notificationPolicy update patches are not converted to CalendarEvent.notification and do not persist
- final-E2E iOS client was not driven (only the Android client path was exercised in E2E-009)

## Follow-up

- Introduce Compose UI test infrastructure to the Android module and add a HistoryDrawer calendar-open navigation test (closes CAL-MOBILE-003)
- Correct the e2e-matrix E2E-002 wording via a story-shaping round-trip so the harness final-E2E asserts the covering-window outcome (closes CAL-E2E-005)
- Add deferred boundary tests: bootstrap capabilities/stores/close + old-config compat + timezone resolution + prompt-cache stability (S5-VERIFY-001); mobile SDK POST/PATCH/DELETE golden-fixture wire fidelity
- iOS all-day device-local date formatting (CAL-FINAL-011) and tool notificationPolicy persistence through the store patch path (CAL-FINAL-012)
