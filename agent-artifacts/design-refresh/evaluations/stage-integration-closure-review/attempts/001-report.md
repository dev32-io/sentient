# Evaluation Report: stage-integration-closure-review

## Boundary

{"workItem":"design-refresh"}

## Criteria Evaluated

- Whole-feature reachable-state completeness and removal of parallel legacy visuals
- Static token/component boundaries, byte-identical platform-owned Rive assets, and exact identity mapping
- Trust/privacy/no-op/task/Interrupt/session ownership contracts
- No Android UI changes, no production/audio/network-disruption verification, and readiness for E2E-001..009

## Observations

MERGE: NO

One blocking Major regression remains.

## Finding

**F-001 — Major, blocking — Android logout can block the UI thread indefinitely**

- **Category:** regression
- **Trigger:** Android logout/auth-expiry while capture teardown or the serialized voice/audio lane is slow or stalled.
- **Expected:** capture cancellation remains ordered, but logout returns promptly so navigation/UI stays responsive.
- **Actual:** `ChatComponent.disconnect()` uses unbounded `runBlocking` (`shared/mobile-data/.../ChatComponent.kt:203`) around `SentientSdk.disconnect()`, which waits at `voice.cancelCaptureAndAwait()` for a producer stop/join and barrier acknowledgement. Android calls this synchronously before login navigation.
- **Impact:** logout can freeze and potentially ANR on a supported Android path.
- **Smallest correction:** preserve byte-identical Android files, but move shared teardown to a lifecycle that survives owner-scope cancellation and returns without blocking the UI; add a held-teardown boundary test proving prompt logout plus eventual ordered cancellation.

## Requirement conclusions

- Inventory closure, foundation/static checks, Rive checksum/identity verification, prototype isolation, and Android visual-diff boundary: pass.
- Web/integration, KMP/Android, and iOS builds/tests: pass.
- Session/old-client compatibility: fail due to F-001.
- Final E2E was not executed or inferred; it is outside this stage review.

## Verification

Passed: design inventory/foundation/avatar checks, `bun run test:int`, required Gradle suite, `./scripts/ios-setup.sh`, iOS `xcodebuild test`, Android baseline diff, and `git diff --check`. `bun run ci` passed on fresh rerun; an initial health-watch timing failure passed both isolated rerun and full rerun.

## Evidence

- **EV-001:** bun run design:inventory:check && bun run design:foundation:check && bun run design:avatar:verify — Passed; inventory closed, static boundaries passed, and deterministic Rive SHA-256 matched bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b.
- **EV-002:** bun run ci (fresh rerun) — Passed: gateway unit summary 2528 pass, 4 skipped, 0 fail.
- **EV-003:** bun run test:int — Passed; configured integration suite completed with Docker-only cases skipped.
- **EV-004:** ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:assembleDebug :android:testDebugUnitTest — BUILD SUCCESSFUL.
- **EV-005:** ./scripts/ios-setup.sh && xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' — Setup succeeded; iOS tests succeeded (25 XCTest plus 114 Swift Testing tests).
- **EV-006:** Android baseline diff check and git diff --check — Passed; Android source/resource baseline diff empty and no whitespace errors.
- **EV-007:** Changed synchronous compatibility wrapper. — Lines 203-205 wrap suspending teardown in unbounded runBlocking.
- **EV-008:** SDK disconnect implementation. — Lines 434-443 wait for voice capture teardown before continuing.
- **EV-009:** Capture teardown fence. — Lines 313-318 enqueue a barrier and await acknowledgement after ordered terminal handling.
- **EV-010:** Android logout call path. — Lines 236-239 invoke session teardown synchronously before navigating to login.

## Findings

- **F-001** (high, open): Unbounded runBlocking makes Android logout wait on capture/audio teardown on the UI callback path.

## Verdict

fail

## Residual Risk

- The first `bun run ci` attempt had one health-watch timing failure; the unchanged test passed in isolation and the complete CI rerun passed (2528 pass, 0 fail), so this is treated as non-blocking test flakiness.
