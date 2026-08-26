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

The prior UI-thread blocking finding is resolved, but the bounded repair leaves one repair-introduced blocking Major contract gap.

## Prior finding

**F-001 — Major — resolved**

`runBlocking` was removed from `ChatComponent.disconnect()`. Android's synchronous callback now schedules teardown on a component-owned non-main lifecycle, and the capture fence has a 1-second timeout with force-local generation and frame cleanup. Fresh KMP tests pass, including prompt callback and hanging-capture coverage.

## New repair finding

**F-002 — Major, blocking — a hanging transport close survives logout indefinitely**

- **Category:** contract gap introduced by the bounded repair.
- **Trigger:** `WebSocketSession.close()` suspends indefinitely during logout, the manager-directed hanging-transport case.
- **Expected:** after bounded capture cancellation, transport teardown is bounded and the SDK-owned terminal scope is always shut down.
- **Actual:** `SdkLifecycle.teardown()` launches `open.close()` in `voiceLifecycleScope` and returns. Logout only invokes `voice.shutdownLane()`, which cancels the voice consumer—not `voiceLifecycleScope`. A hanging close therefore retains the old session and coroutine indefinitely. The new test releases the fake close after `disconnect()` returns, so it does not prove forced scope shutdown.
- **Impact:** logout can leak an authenticated socket/session coroutine; repeated failures can accumulate resources. The explicit hanging-transport and scope-shutdown acceptance requirement remains unmet.
- **Smallest correction:** bound the best-effort close child and always cancel the SDK-owned terminal scope afterward. Keep the fake close suspended in the test and assert cancellation/terminal lifecycle completion.

## Verification

Freshly passed: design foundation/avatar/inventory checks, `bun run ci` (2528 pass, 0 fail), `bun run test:int`, forced KMP Android/iOS test execution, Android assemble/unit tests, Android visual baseline exclusion, and `git diff --check`. Final E2E was not run or inferred in this re-review.

## Evidence

- **EV-001:** git diff 8f0215d4..ce4c13eb -- shared/mobile-data shared/mobile-sdk — Inspected the complete bounded repair; no Android or iOS visual files changed.
- **EV-002:** ./gradlew :shared:mobile-sdk:iosSimulatorArm64Test :shared:mobile-sdk:testDebugUnitTest :shared:mobile-data:iosSimulatorArm64Test :shared:mobile-data:testDebugUnitTest --rerun-tasks — BUILD SUCCESSFUL; all selected KMP test tasks were freshly executed.
- **EV-003:** ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:assembleDebug :android:testDebugUnitTest — BUILD SUCCESSFUL.
- **EV-004:** bun run ci && bun run test:int — Passed; CI reported 2528 pass, 4 skipped, 0 fail. Integration command completed with approved Docker-only skips.
- **EV-005:** bun run design:foundation:check && bun run design:avatar:verify && bun run design:inventory:check — Passed; canonical Rive SHA-256 remained bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b.
- **EV-006:** Android baseline exclusion and git diff --check — Passed; no Android source/resource changes from the feature baseline and no whitespace errors.
- **EV-007:** Prior finding repair. — Lines 208-247 remove runBlocking and use a component-owned asynchronous lifecycle.
- **EV-008:** Transport close lifecycle. — Lines 293-303 launch transport close in the supplied scope without timeout, join, or scope shutdown.
- **EV-009:** SDK-owned voice lifecycle and logout. — Lines 199-202 create voiceLifecycleScope; lines 462-474 never cancel it after launching transport close.
- **EV-010:** Voice lane shutdown behavior. — Lines 346-351 cancel only the consumer job and drain commands; they do not cancel the owning lifecycle scope.
- **EV-011:** Hanging transport test proof gap. — The test releases the stalled close immediately after disconnect returns and does not assert close-job or scope cancellation.

## Findings

- **F-001** (high, resolved): Unbounded UI-path runBlocking was removed and capture teardown was made bounded and asynchronous.
- **F-002** (high, open): A hanging transport close runs in an SDK-owned scope that logout never cancels, so terminal teardown is not bounded or complete.

## Verdict

fail

## Residual Risk

None recorded.
