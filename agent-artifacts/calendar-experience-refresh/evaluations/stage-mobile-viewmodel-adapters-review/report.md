# Evaluation Report: stage-mobile-viewmodel-adapters-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Thin Android StateFlow and iOS SKIE AsyncSequence mapping with correct cancellation
- A focused XCFramework/Swift test proves the complete nested CalendarExperienceState bridges before SwiftUI components depend on it
- Exact intent/identity forwarding with raw offset-bearing recurrence anchors and no native pagination/filter/cache/prefetch/mutation policy
- Every supported state from sentient-design/design/mobile/calendar.html and sentient-design/components/mobile/sentient-mobile.js is representable without prototype data

## Observations

MERGE: YES_WITH_RISK

MVA-001 is resolved. The production iOS adapter now calls the shared, idempotent `CalendarExperience.start(window:)` synchronously before creating its SKIE collector (`ios/App/Settings/Calendar/CalendarViewModel.swift:109-112,159-167`). Focused tests verify activation-before-collection, cached → refreshing → fresh mapping, coalesced route recreation, and disposal of only the owned collector while session work remains alive.

Minor — MVA-002: The repair-added route-recreation test captures mutable local `captured` in a concurrently executing cancellation handler (`ios/Tests/CalendarViewModelTests.swift:367-379`). Xcode warns this becomes an error in Swift 6 language mode. This is non-blocking for the current stage and does not invalidate the repair, but the test should use a concurrency-safe immutable continuation holder before enabling Swift 6 mode.

Requirement conclusions:
- Prior blocking activation defect: RESOLVED.
- Cache-first activation/revalidation and idempotent route recreation: PASS.
- Collector cancellation without closing session experience: PASS.
- No native fetch/pagination/cache policy introduced: PASS.
- Stage checks: PASS.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :android:testDebugUnitTest :android:assembleDebug — PASS
- **EV-002:** source scripts/env.sh && scripts/ios-setup.sh — PASS
- **EV-003:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — PASS; 85 tests passed
- **EV-004:** source scripts/env.sh && git diff --check — PASS
- **EV-005:** Shared activation precedes SKIE collection. — MVA-001 resolved
- **EV-006:** Compiler warns about mutable continuation capture in concurrent cancellation handler. — Non-blocking Swift 6 compatibility risk

## Findings

- **MVA-002** (low, open): Repair-added test uses a mutable captured continuation that becomes an error in Swift 6 mode.

## Verdict

pass

## Residual Risk

- Repair test concurrency capture warning will become a compile error under Swift 6 language mode.
