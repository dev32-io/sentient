# Evaluation Report: stage-stage-8-mobile-platform-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Route-scoped ViewModels consume shared use cases (not raw repositories) with state folding
- Accessibility identifiers consistent with mobile E2E contracts

## Observations

MERGE: NO

Re-review inspected only the bounded repair from the prior reviewed implementation to repair commit 81922261, plus the current stage metadata. The Android, shared mobile-data/mobile-sdk, gateway, MobileData XCFramework, and iOS build/test checks all pass.

Resolved prior findings:
- CAL-MOBILE-001: shared listBoth performs separate timed/all-day calls and both VMs use it.
- CAL-ANDROID-001: create timestamps/occurrence metadata are stripped on the wire; timed updates preserve kind.
- CAL-IOS-001: iOS now exposes create/update/delete controls and invokes the ViewModel.
- CAL-MOBILE-002: both platforms format starts in the device timezone.
- CAL-ANDROID-002: drawer calendar-open action navigates to settings/calendar.
- CAL-MOBILE-004: occurrenceId/baseEventId are preserved and persistedId drives CRUD.

Blocking issues remaining:
- Major CAL-IOS-002: the repair's iOS all-day update branch returns the original date instead of the edited date, so Save silently fails to change all-day event dates (ios/App/Settings/Calendar/CalendarViewModel.swift:240-243). This is repair-introduced.
- Major CAL-MOBILE-003: added tests cover helpers and state folds, but do not exercise actual CalendarScreen/drawer navigation wiring or iOS ViewModel CRUD/use-case calls, despite the explicit manager acceptance.

## Evidence

- **EV-001:** Android and touched shared KMP calendar tests/compiles. — PASS
- **EV-002:** Touched gateway calendar seams. — PASS; 21 tests
- **EV-003:** MobileData assembly and authoritative iOS build/tests. — PASS; CalendarViewModelTests passed; 71 total tests
- **EV-004:** Fresh mixed-kind listing verification. — {"allDayOk":true,"timedOk":true,"allDayCount":1,"timedCount":1}
- **EV-005:** Repair diff has no whitespace errors. — PASS; no output
- **EV-006:** Sanitized repair-regression evidence. — All-day branch returns value.date from the matched event instead of the edited input.

## Findings

- **CAL-MOBILE-001** (high, resolved): Separate timed/all-day calls now merge successfully.
- **CAL-ANDROID-001** (high, resolved): Server-owned timestamps are omitted and timed updates preserve their kind.
- **CAL-IOS-001** (high, resolved): Create, update, and delete controls are wired.
- **CAL-MOBILE-002** (high, resolved): Timed and all-day starts are formatted appropriately for the device timezone.
- **CAL-ANDROID-002** (high, resolved): calendar-open is rendered and navigates to the calendar route.
- **CAL-MOBILE-003** (high, open): Tests still do not exercise actual screen/drawer navigation wiring or iOS ViewModel CRUD/use-case calls required by the manager acceptance.
- **CAL-MOBILE-004** (high, resolved): Both occurrence identities are preserved and persistedId is used for mutation.
- **CAL-IOS-002** (high, open): All-day Save ignores the edited date and returns the original event date.

## Verdict

fail

## Residual Risk

- The declared task selector :shared:mobile-data:assembleXCFramework remains ambiguous in this checkout; the concrete :shared:mobile-data:assembleMobileDataXCFramework task succeeds and the iOS build/tests pass.
