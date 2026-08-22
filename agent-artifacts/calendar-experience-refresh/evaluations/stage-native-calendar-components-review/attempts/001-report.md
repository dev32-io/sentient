# Evaluation Report: stage-native-calendar-components-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Leaf Compose/SwiftUI components are controlled and side-effect free
- Exact mobile comparison uses sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js at logical 390x844 and 430x932
- Reference geometry includes 58 top bar, 16 inset, 44 targets, 46 view controls, 64 rows, 42 Month cells, complete Year, 84% sheets, filters, agenda, floating bar, focus, scaling, safe areas, and reduced motion
- Prototype fixed data and member/color/place/reminder semantics are absent; semantic accessibility inspection is required but an actual assistive-technology session is not a stage gate

## Observations

MERGE: NO

The stage checks pass, but five Major acceptance/correctness defects remain: both platforms add a Day canvas contrary to the focused-agenda contract; Android duplicates shared date/view navigation policy; Android enables invalid saves; iOS applies the wrong mode-specific permission gate; and iOS permits draft edits that reset SUBMITTING to EDITING while a request is in flight. Android overlay press motion also bypasses the stage's local reduced-motion mechanism (Minor).

Requirement conclusions: controlled/no-I/O leaf structure generally conforms; Month/Week/Year projections, filters, geometry constants, sheet bounds, safe-area padding, previews, and pure tests are present; Day hierarchy, no-duplicated-policy, mutation action correctness, submitting stability, and complete reduced-motion behavior do not conform.

## Evidence

- **EV-001:** git diff --stat deaca6ed372c2b551be081a08887aabab6a23d47 d33301d67cbe3c3bfa93ec9bb2a7b45fa88033a0 && git diff --check — Bounded stage implementation is 22 files / 5,105 insertions; diff check passed.
- **EV-002:** source scripts/env.sh && ./gradlew :android:testDebugUnitTest :android:assembleDebug — Passed (BUILD SUCCESSFUL).
- **EV-003:** source scripts/env.sh && scripts/ios-setup.sh — Passed; iOS project and XCFramework setup completed.
- **EV-004:** source scripts/env.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' — Passed; 98 tests in 15 suites. Result bundle is outside the repository under Xcode DerivedData.
- **EV-005:** SelectDate owns Month-to-Day and Week-retention policy. — Lines 80-88 implement the shared transition.
- **EV-006:** UpdateDraft phase behavior. — Lines 475-505 reset mutation phase to EDITING/CONFLICT without a submitting guard.

## Findings

- **F-001** (high, open): Both native Day views render a separate styled canvas before the agenda.
- **F-002** (high, open): Android duplicates Month-to-Day policy and emits redundant date plus view callbacks.
- **F-003** (high, open): Save enablement ignores blank/invalid drafts and required recurrence-scope selection.
- **F-004** (high, open): Save uses aggregate isAvailable instead of canCreate/canEdit for the active editor mode.
- **F-005** (high, open): Draft controls remain enabled while submitting and can reset shared phase to EDITING, allowing racing submissions.
- **F-006** (low, open): Overlay press scale always uses a timed tween without consulting LocalCalendarReducedMotion.

## Verdict

fail

## Residual Risk

- No actual assistive-technology session was required or run; semantic accessibility was inspected statically.
- Fresh pixel/screenshot comparison against the served handoff was not available as an automated stage check; committed previews and review notes were inspected.
