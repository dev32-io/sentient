# Evaluation Report: stage-platform-foundations-review

## Boundary

{"workItem":"design-refresh"}

## Criteria Evaluated

- Web and Swift native component semantics, accessibility, exact material recipes, and no prototype runtime dependencies
- Platform-owned Rive packaging/fallback and exact three-state adapter
- KMP capture serialization, frame/terminal ordering, lifecycle cancellation, and unchanged Android UI

## Observations

MERGE: NO

Reviewed commit `83ebc267d38ec0c463ec04ce4f42cc5702be7fbb` against the platform-foundations stage boundary (implementation assembled in `fa449dc5..21e53024`; later commits only update task manifests).

Findings: 3 blocking Major, 2 non-blocking Minor.

Requirement conclusions:
- KMP capture wire IDs, Send/Cancel distinction, Hold-to-Auto ordering, stale-frame gating, and Android compatibility are covered and their stage checks pass, but lifecycle/session teardown ordering is not safe because the terminal command is not awaited before scope cancellation (F2).
- Web Rive packaging, checksum, three-state mapping, reduced-motion input, fallback, build, typecheck, and tests pass. Dialog inert-background behavior remains incomplete (F3), and two compatibility/accessibility regressions remain (F4/F5).
- Swift v2 projection and native build/tests pass, but the native component styles do not replicate the authoritative material recipes (F1).

Verification:
- PASS: `bun run design:foundation:check`
- PASS: `bun run design:avatar:verify`
- PASS after `bun install --frozen-lockfile`: WebUI unit tests (236), typecheck, build
- PASS: KMP/mobile-data allTests, Android assembleDebug and unit tests
- PASS: `./scripts/ios-setup.sh`
- PASS: iPhone 16 simulator xcodebuild tests (4 XCTest + 108 Swift Testing tests)
- PASS: `git diff --check`

Merge recommendation: do not merge until F1-F3 are corrected and their focused proof is added.

## Evidence

- **EV-001:** Swift material implementations showing generic flat/linear faces and single shadows rather than the projected recipes. — Supports F1.
- **EV-002:** Terminal requests are queued on the scope-owned serialized consumer. — Supports F2.
- **EV-003:** Session close calls disconnect and then immediately cancels the SDK scope. — Supports F2.
- **EV-004:** Background isolation is opt-in and defaults false. — Supports F3.
- **EV-005:** Compatibility props monospace and dirty are explicitly discarded. — Supports F4.
- **EV-006:** ARIA menu popup lacks menu-item and arrow-key/focus behavior. — Supports F5.
- **EV-007:** bun run design:foundation:check && bun run design:avatar:verify; bun install --frozen-lockfile; bun run --filter '@sentient/webui' test:unit; bun run --filter '@sentient/webui' typecheck; bun run --filter '@sentient/webui' build — Design checks and WebUI checks passed; 236 WebUI tests passed.
- **EV-008:** ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:assembleDebug :android:testDebugUnitTest — Passed.
- **EV-009:** ./scripts/ios-setup.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' — Passed; 4 XCTest and 108 Swift Testing tests.
- **EV-010:** git diff --check fa449dc5d0016d2f38101dfb95310472823aed3d..83ebc267d38ec0c463ec04ce4f42cc5702be7fbb — Passed.

## Findings

- **F1** (high, open): SwiftUI plate, well, and button styles do not implement the required reviewed material recipes.
- **F2** (high, open): SDK/session teardown does not await serialized capture cancellation before tearing down and cancelling its scope.
- **F3** (high, open): Most production Dialog consumers still do not inert the background.
- **F4** (medium, open): Textarea compatibility wrapper silently drops monospace and dirty states.
- **F5** (medium, open): Compatibility Select declares a menu but does not implement menu keyboard or item semantics.

## Verdict

fail

## Residual Risk

- No structured visual review was part of these stage commands; after the recipe correction, component previews still need human comparison against the reviewed prototype authority.
