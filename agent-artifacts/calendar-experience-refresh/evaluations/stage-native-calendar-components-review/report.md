# Evaluation Report: stage-native-calendar-components-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Leaf Compose/SwiftUI components are controlled and side-effect free
- Exact mobile comparison uses sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js at logical 390x844 and 430x932
- Reference geometry includes 58 top bar, 16 inset, 44 targets, 46 view controls, 64 rows, 42 Month cells, complete Year, 84% sheets, filters, agenda, floating bar, focus, scaling, safe areas, and reduced motion
- Prototype fixed data and member/color/place/reminder semantics are absent; semantic accessibility inspection is required but an actual assistive-technology session is not a stage gate

## Observations

MERGE: YES

All six prior findings are resolved in the bounded repair diff, and no repair-introduced regression was found. Day is agenda-only on both platforms; Android forwards one shared date intent; Save uses authoritative shared command-builder validation and mode-specific permissions; native mutation controls and the shared reducer are submission-race hardened; and Android overlay press feedback snaps under reduced motion.

The declared Android, iOS setup/test, and diff checks pass. Focused repair tests cover Day hierarchy, one-callback selection, draft/scope validation, mode permissions, reduced motion, and the submitting-state race.

## Evidence

- **EV-001:** git show --stat 071fd69a96f23d584567c53a2d2978681dc4b653 — Bounded repair changes 16 files with focused production and test updates.
- **EV-002:** source scripts/env.sh && ./gradlew :android:testDebugUnitTest :android:assembleDebug — Passed (BUILD SUCCESSFUL).
- **EV-003:** source scripts/env.sh && scripts/ios-setup.sh — Passed; project generation and XCFramework setup completed.
- **EV-004:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — Passed; 99 tests in 15 suites.
- **EV-005:** source scripts/env.sh && ./gradlew :shared:mobile-data:testDebugUnitTest — Passed, including the shared submission-race and authoritative validation tests.
- **EV-006:** source scripts/env.sh && git diff --check — Passed.

## Findings

- **F-001** (high, resolved): Separate Day canvases removed.
- **F-002** (high, resolved): Android now emits one date callback and relies on shared navigation.
- **F-003** (high, resolved): Save consumes shared command-builder validation, including required edit scope.
- **F-004** (high, resolved): Save selects canCreate versus canEdit by editor mode.
- **F-005** (high, resolved): Mutating/dismissal controls are disabled and shared intents are ignored during submission.
- **F-006** (low, resolved): Reduced motion uses immediate snap feedback.

## Verdict

pass

## Residual Risk

- No actual assistive-technology session was required or run; accessibility semantics remain statically inspected.
- Visual conformance relies on committed previews/review notes rather than an automated pixel-diff stage gate.
