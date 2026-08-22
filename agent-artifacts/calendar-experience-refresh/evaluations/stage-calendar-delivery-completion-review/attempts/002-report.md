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

Three prior findings are resolved, but CAL-DELIVERY-002 remains Major and blocks merge because the checked-in direct-Maestro inventory still cannot drive the accepted matrix.

Prior findings:
- CAL-DELIVERY-001 — Resolved. iOS now forwards current locale, first weekday, hour cycle, and time-zone projection context on open and locale/time-zone changes; edit no longer copies the device projection zone into draft zone metadata.
- CAL-DELIVERY-002 — Major, open. `qa/mobile/flows/ios/80-calendar-timezone-dst.yaml:8-14` asserts `calendar-canvas`, but the iOS production calendar defines no such accessibility identifier, so the temporal flow fails in Week/Month/Year. `qa/mobile/flows/ios/77-calendar-reconnect.yaml:5-10` invokes `_calendar/open-calendar.yaml`, which navigates through login/history/settings, rather than observing connectivity restoration while the existing Calendar remains open as CAL-UX-011 requires. `qa/mobile/flows/android/calendar/09-cache-first.yaml:6-13` checks nonexistent `calendar-loading` and waits for `calendar-freshness`, an ID permanently attached to the LazyColumn, so it does not observe delayed revalidation completion for CAL-UX-008. Merge remains blocked on the explicit requirement that committed direct flows drive every applicable CAL-UX-001..014 case.
- CAL-DELIVERY-003 — Resolved. Shared projection owns the canonical four-day Month agenda and both native clients consume it.
- CAL-DELIVERY-004 — Resolved. iOS announces only non-fresh-to-fresh transitions, suppressing initial and duplicate announcements.

Verification:
- Shared/Android tests and debug assembly passed.
- iOS setup passed.
- Xcode tests passed: 104 tests.
- `git diff --check` passed.

No additional repair regression was found outside the remaining E2E-inventory defect.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :android:testDebugUnitTest :android:assembleDebug — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && scripts/ios-setup.sh — BUILD SUCCESSFUL; project generated
- **EV-003:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — TEST SUCCEEDED; 104 tests passed
- **EV-004:** source scripts/env.sh && git diff --check — Clean
- **EV-005:** rg -l 'accessibilityIdentifier\("calendar-canvas"\)' ios/App/Settings/Calendar — No production definition found
- **EV-006:** rg -n 'runFlow: _calendar/open-calendar.yaml' qa/mobile/flows/ios/77-calendar-reconnect.yaml — Reconnect flow reopens Calendar at line 6

## Findings

- **CAL-DELIVERY-001** (high, resolved): iOS device projection context forwarding is implemented without synthesizing an event IANA zone.
- **CAL-DELIVERY-002** (high, open): Committed direct-Maestro flows still contain an undefined iOS identifier and do not observably drive reconnect/cache-first acceptance cases.
- **CAL-DELIVERY-003** (high, resolved): Shared authoritative four-day Month agenda is consumed by both native clients.
- **CAL-DELIVERY-004** (low, resolved): Freshness recovery announcement is implemented with initial/duplicate suppression.

## Verdict

fail

## Residual Risk

- Semantic inspection is not an actual TalkBack or VoiceOver session; actual assistive-technology execution remains optional under the contract.
