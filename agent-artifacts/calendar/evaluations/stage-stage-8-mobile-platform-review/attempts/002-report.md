# Evaluation Report: stage-stage-8-mobile-platform-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Route-scoped ViewModels consume shared use cases (not raw repositories) with state folding
- Accessibility identifiers consistent with mobile E2E contracts

## Observations

MERGE: NO

Android and iOS route/Koin/SettingsComponent wiring and shared screen/category IDs are present. Android unit/compile checks and iOS build/tests pass, but the bounded implementation has blocking behavior and acceptance gaps:

- Major CAL-MOBILE-001: both ViewModels query only an all-day window; the current store rejects mixed timed/all-day calendars, so timed events make mobile listing fail.
- Major CAL-ANDROID-001: Android creates events with empty createdAt/updatedAt values (schema rejection) and rewrites timed-event updates to an invalid all-day start.
- Major CAL-IOS-001: iOS CalendarScreen is read-only; required create/update/delete controls are absent.
- Major CAL-MOBILE-002: iOS prints raw UTC instants and Android renders no event date/time, violating device-timezone rendering.
- Major CAL-ANDROID-002: HistoryDrawer has no calendar affordance/identifier; only the settings-root row was added despite the drawer requirement.
- Major CAL-MOBILE-003: iOS adds no calendar tests; Android tests cover only two list-fold helpers, not screen wiring or CRUD transitions.
- Major CAL-MOBILE-004: occurrence-shaped list rows lose baseEventId in CalendarEventPage, so Android CRUD targets occurrence IDs rather than persisted recurring-event IDs.

Positive requirement conclusions: route destinations, Koin binding, shared-usecase injection, settings-root entries, and common accessibility IDs are present.

## Evidence

- **EV-001:** Android calendar-filtered unit test and Kotlin compile. — PASS
- **EV-002:** Concrete MobileData XCFramework assembly task. — PASS
- **EV-003:** Authoritative iOS project/scheme build and simulator tests. — PASS; 66 existing tests passed
- **EV-004:** Sanitized schema reproduction for empty Android timestamps. — {"success":false,"issueCount":2}
- **EV-005:** Sanitized mixed-time-kind listing reproduction. — {"ok":false,"error":"invalid"}
- **EV-006:** Reviewed tree has no whitespace errors. — PASS; no output

## Findings

- **CAL-MOBILE-001** (high, open): All-day-only query fails when the calendar contains timed events.
- **CAL-ANDROID-001** (high, open): Create sends schema-invalid timestamps; timed updates are converted to an empty all-day date.
- **CAL-IOS-001** (high, open): The iOS screen exposes listing and refresh only; CRUD ViewModel methods are not wired to controls.
- **CAL-MOBILE-002** (high, open): iOS displays raw UTC and Android omits event date/time rendering.
- **CAL-ANDROID-002** (high, open): Only a settings-root row exists; the drawer has no calendar action or ID.
- **CAL-MOBILE-003** (high, open): Android coverage is limited to two pure list folds and iOS has no calendar test file.
- **CAL-MOBILE-004** (high, open): Occurrence IDs are decoded as CalendarEvent.id while baseEventId is dropped, so Android CRUD addresses the wrong persisted ID for recurring rows.

## Verdict

fail

## Residual Risk

- The task artifact's literal :shared:mobile-data:assembleXCFramework selector is ambiguous in this checkout; the concrete :shared:mobile-data:assembleMobileDataXCFramework task passed, followed by successful xcodebuild build/test. Because the reviewed code has blocking findings, this verification drift does not change the verdict.
