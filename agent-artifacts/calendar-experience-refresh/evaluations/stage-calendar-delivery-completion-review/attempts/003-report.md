# Evaluation Report: stage-calendar-delivery-completion-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Android and iOS production code remains thin over shared StateFlow with no duplicated cache/network/policy
- Production screens compare directly to sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js at exact logical 390x844 and 430x932 profiles
- Day/Week/Month/Year, filters, sheets, cache/offline/recovery, mutations, conflicts, permissions, temporal behavior, semantic accessibility, safe areas, and reduced motion
- The runtime's final E2E agent—not concurrent task checks—runs Android then iOS sequentially with direct Maestro/existing fault controls, unique disposable fixture namespaces, guaranteed cleanup, and CAL-UX-001..014 evidence; no qa/mobile runner extension or mandatory actual assistive-technology session is required

## Observations

MERGE: NO

CAL-DELIVERY-002 remains Major and open, and the repair introduces one additional Major visual regression.

Findings:
- Major — CAL-DELIVERY-002 remains open. The selector/syntax defects are fixed and the paired flows now assert unique cached/recovery fixtures, but production does not trigger the automatic revalidation those flows await. `CalendarExperience.kt:1480-1483` explicitly defines recovery as a caller signal (`onConnectivityRecovered()`). A source search finds no Android or iOS production caller—only the common test. `ios/App/Session/UserSession.swift:112-121` responds to NWPath changes only by ensuring the chat/socket connection, and restarting the gateway does not create an NWPath transition. Android session wiring likewise does not notify CalendarExperience. Consequently iOS `77`/`82b` and Android `06b`/`09b` cannot make `CALENDAR_RECOVERY_EVENT_TAG` appear automatically without an uncommitted manual refresh/navigation action. CAL-UX-008/011 and the manager’s automatic-revalidation proof remain unmet.
- Major — CAL-DELIVERY-005, repair-introduced regression. `ios/App/Settings/Calendar/CalendarScaffold.swift:220-227` now renders a visible 44pt “Calendar is up to date” row for every normal fresh calendar state. The row was absent before this repair, is absent from Android and the authoritative normal mobile composition, and shifts the canvas/agenda solely to expose an E2E state selector. This regresses AC-002/004/014 reference fidelity.

Prior closure status:
- CAL-DELIVERY-001, 003, and 004 remain resolved.
- The former undefined iOS selectors and reconnect-flow relaunch were repaired.

Verification:
- Shared/Android checks passed.
- iOS setup passed.
- Xcode tests passed: 105 tests.
- Calendar flow validation passed: 375 selectors across 47 Maestro flows.
- `git diff --check` passed.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :android:testDebugUnitTest :android:assembleDebug — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && scripts/ios-setup.sh — BUILD SUCCESSFUL; project generated
- **EV-003:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — TEST SUCCEEDED; 105 tests passed
- **EV-004:** qa/mobile/validate-calendar-flows.rb — 375 selectors and 47 Maestro flows validated
- **EV-005:** rg -n 'onConnectivityRecovered|connectivityRecovered|recoverFromOffline' shared android ios -g'*.kt' -g'*.swift' — Only CalendarExperience declarations and a common test; no native production caller
- **EV-006:** source scripts/env.sh && git diff --check — Clean

## Findings

- **CAL-DELIVERY-002** (high, open): Paired flows are syntactically valid but production never signals CalendarExperience to revalidate automatically after connectivity recovery.
- **CAL-DELIVERY-005** (high, open): Repair adds a persistent visible fresh-status row that regresses the authoritative normal mobile composition.

## Verdict

fail

## Residual Risk

- Semantic inspection is not an actual TalkBack or VoiceOver session; actual assistive-technology execution remains optional under the contract.
