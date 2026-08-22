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

Stage checks pass, but three Major acceptance defects block merge.

Findings:
- Major — CAL-DELIVERY-001: `ios/App/Settings/Calendar/CalendarScreen.swift:46-70` never sends device locale/time zone through `vm.setLocale`. Shared `CalendarLocale` defaults to en-US/UTC, so iOS timed projections and timezone/DST behavior can remain UTC.
- Major — CAL-DELIVERY-002: committed Maestro coverage is not sufficient for CAL-UX-001..014. `qa/mobile/flows/android/calendar/README.md:25` explicitly omits 008..012; Android has no cache-first flow and its offline flow only observes either status. Required cached navigation/filtering, uncached mutation refusal, complete create variants, and matrix navigation are absent. `qa/mobile/flows/ios/CALENDAR.md:13` also tells the agent to stop at 81, omitting cache-first flow 82, and several flows do not exercise their full matrix cases. This violates the assembly boundary proof that the final agent can drive committed steps without inventing cases.
- Major — CAL-DELIVERY-003: Month agenda behavior diverges from the authoritative runtime and between platforms. `sentient-design/components/mobile/sentient-mobile.js:67` renders four days from the Month anchor; Android renders only `selectedDate` (`CalendarScreen.kt:196-202`), while iOS renders all event-bearing cells in the month (`CalendarSurfaceSupport.swift:130-139`).
- Minor — CAL-DELIVERY-004: iOS does not announce refresh/reconnect completion. `stateAnnouncement` returns nil for fresh state and `CalendarScaffold` drops nil announcements.

Requirement conclusions:
- Thin shared-StateFlow production architecture: satisfied in the bounded assembly.
- Build/unit/setup checks: satisfied.
- Reference-faithful mobile behavior and temporal/accessibility requirements: not satisfied.
- Final sequential direct-Maestro CAL-UX-001..014 drivability: not satisfied.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :android:testDebugUnitTest :android:assembleDebug — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && scripts/ios-setup.sh — BUILD SUCCESSFUL; project generated
- **EV-003:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — TEST SUCCEEDED; 101 tests passed
- **EV-004:** source scripts/env.sh && git diff --check — Clean

## Findings

- **CAL-DELIVERY-001** (high, open): iOS does not forward device locale/time zone, leaving shared projections at default en-US/UTC.
- **CAL-DELIVERY-002** (high, open): Committed direct-Maestro flows omit required persisted matrix cases and cannot drive CAL-UX-001..014 as accepted.
- **CAL-DELIVERY-003** (high, open): Android and iOS Month agendas both diverge from the authoritative four-day mobile runtime behavior.
- **CAL-DELIVERY-004** (low, open): iOS omits a live announcement when freshness returns to up-to-date.

## Verdict

fail

## Residual Risk

- Semantic inspection is not an actual TalkBack or VoiceOver session; such sessions remain optional under the contract.
- Passing unit/build checks do not establish the required exact 390x844 and 430x932 runtime visual comparisons.
