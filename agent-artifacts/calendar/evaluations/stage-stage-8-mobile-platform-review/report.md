# Evaluation Report: stage-stage-8-mobile-platform-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Route-scoped ViewModels consume shared use cases (not raw repositories) with state folding
- Accessibility identifiers consistent with mobile E2E contracts

## Observations

MERGE: NO

Iteration 2 re-review inspected only the bounded source repair from 81922261 to 80d64695; current HEAD 3fbc1e8 contains the review-loop metadata. All Android, shared mobile-data, MobileData XCFramework, and iOS checks pass.

Resolved prior findings:
- CAL-MOBILE-001, CAL-ANDROID-001, CAL-IOS-001, CAL-MOBILE-002, CAL-ANDROID-002, and CAL-MOBILE-004 remain resolved.
- CAL-IOS-002 is resolved: the all-day branch now uses the edited input date, and the new iOS test verifies it while exercising create/update/delete use-case calls.

Remaining blocker:
- Major CAL-MOBILE-003 remains open. Android now tests ViewModel create/update/delete calls, but its navigation test directly invokes the extracted `navigateToCalendar` helper. It does not exercise the `HistoryDrawer`/`HistoryContent` calendar-open action or a Compose host, contrary to the explicit requirement for actual drawer navigation wiring. This is an unmet acceptance requirement, so merge remains blocked.

## Evidence

- **EV-001:** Fresh Android calendar tests and Kotlin compile. — PASS
- **EV-002:** Fresh shared mobile-data calendar tests and compile. — PASS
- **EV-003:** Fresh MobileData assembly and iOS build/test. — PASS; CRUD/all-day integration test passed; 72 total tests
- **EV-004:** Bounded source repair diff check. — PASS
- **EV-005:** Sanitized evidence for the remaining test-coverage gap. — Test references only navigateToCalendar; no HistoryDrawer/HistoryContent/ChatHost exercise.

## Findings

- **CAL-MOBILE-001** (high, resolved): Separate timed/all-day calls remain in place and both platform ViewModels use them.
- **CAL-ANDROID-001** (high, resolved): Server-owned metadata is omitted on create and timed updates preserve kind.
- **CAL-IOS-001** (high, resolved): Create, update, and delete controls are wired.
- **CAL-MOBILE-002** (high, resolved): Device-timezone formatting remains intact.
- **CAL-ANDROID-002** (high, resolved): The calendar affordance and production route wiring remain present.
- **CAL-MOBILE-003** (high, open): Android CRUD tests were added, but the navigation test bypasses HistoryDrawer/HistoryContent and directly tests navigateToCalendar, leaving the explicit actual drawer-wiring acceptance unmet.
- **CAL-MOBILE-004** (high, resolved): Occurrence/base identities and persistedId mutation behavior remain intact.
- **CAL-IOS-002** (high, resolved): The shadowing bug is fixed and the edited date reaches the update use case.

## Verdict

fail

## Residual Risk

- The declared :shared:mobile-data:assembleXCFramework selector remains ambiguous in this checkout; the concrete :shared:mobile-data:assembleMobileDataXCFramework task succeeds and the iOS build/tests pass.
