# iOS testing details

This file expands `.claude/rules/ios.md`. Read it when the testing rule is unclear.

## Unit tests

The XcodeGen test target is `SentientAppTests`; tests import the app module:

```swift
import Testing
@testable import SentientApp
```

Use Swift Testing for new tests and XCTest where the surrounding test requires it. Prefer fakes at component/usecase boundaries that record inputs and return deterministic outcomes. Test ViewModels on `@MainActor`, assert state transitions, and use observable completion or an existing controllable async seam for retry, timeout, debounce, or scheduling behavior. Do not use arbitrary sleeps or invent a project-wide clock abstraction in an unrelated change.

## UI and E2E

Use accessibility identifiers and drive the simulator with Maestro or XCUITest. There is no `-uiTestMode` fake-service switch; flows use the configured app/gateway and explicit test setup. Run the supported flows through `qa/mobile/run-e2e.sh`.

Gateway-stop/reconnect E2E is supported on iOS. Some fault-arming broadcasts have no iOS equivalent and remain Android-only; do not describe those Android flows as iOS coverage. Keep known gaps explicit rather than silently skipping them.
