# Evaluation Report: stage-mobile-viewmodel-adapters-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Thin Android StateFlow and iOS SKIE AsyncSequence mapping with correct cancellation
- A focused XCFramework/Swift test proves the complete nested CalendarExperienceState bridges before SwiftUI components depend on it
- Exact intent/identity forwarding with raw offset-bearing recurrence anchors and no native pagination/filter/cache/prefetch/mutation policy
- Every supported state from sentient-design/design/mobile/calendar.html and sentient-design/components/mobile/sentient-mobile.js is representable without prototype data

## Observations

MERGE: NO

Major — MVA-001: The production iOS adapter does not start `CalendarExperience`. `SkieCalendarExperienceStateSource.collect` only iterates `experience.state`, and both `CalendarViewModel` initializers only start that collector (`ios/App/Settings/Calendar/CalendarViewModel.swift:99-115,130-137`). Shared cache observation/revalidation is activated only by `CalendarExperience.start()`/`observe()` (`shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/calendar/CalendarExperience.kt:320-348`). Consequently, opening the iOS Calendar leaves it on the inert initial state instead of loading SQLDelight cache, revalidating, and prefetching. The test source lacks an activation seam, so all tests pass without exercising this production behavior. This blocks the iOS cache-first/open acceptance contract.

Requirement conclusions:
- Android thin StateFlow mapping, lifecycle cancellation, exact typed intent/identity forwarding: PASS.
- iOS complete nested SKIE bridge proof, cancellable MainActor collection, typed forwarding: PASS except for experience activation.
- No native repository/database/filter/pagination/cache/prefetch policy: PASS.
- iOS calendar-open cache-first sequence: FAIL (MVA-001).
- Stage checks: PASS.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :android:testDebugUnitTest --rerun-tasks && ./gradlew :android:assembleDebug — PASS
- **EV-002:** source scripts/env.sh && scripts/ios-setup.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — PASS; 84 tests passed
- **EV-003:** source scripts/env.sh && git diff --check — PASS
- **EV-004:** Collection is started, but CalendarExperience observation is not activated. — Production adapter only reads state and dispatches intents.
- **EV-005:** Shared observation startup boundary. — Cache observation/revalidation begins in observe()/start().

## Findings

- **MVA-001** (medium, open): iOS collects an unstarted CalendarExperience, so opening Calendar does not initiate cache observation/revalidation.

## Verdict

fail

## Residual Risk

None recorded.
