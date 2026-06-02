---
description: iOS testing -- Swift Testing, XCUITest, Maestro, fakes, Clock injection.
paths:
  - "ios/**"
---

# iOS Testing

Three layers: unit (Swift Testing / XCTest), UI regression (XCUITest), agent-driveable E2E (Maestro).

## Unit — Swift Testing (preferred) / XCTest (legacy)
- Target: pure logic, ViewModels, use-cases, repositories with fake transport. NEVER real network/filesystem.
- New code (iOS 17+ / Xcode 16+): Swift Testing (`@Test`, `#expect`, `#require`).
- `async` test methods are first-class. NEVER use semaphores / `XCTWaiter` to block — `await` it.
- Run via `xcodebuild test`; `swift test` for SwiftPM packages.

## SwiftUI previews as snapshot seeds
- Treat `#Preview` declarations as snapshot-test seeds; wire into a snapshot library (swift-snapshot-testing) for visual regression.
- Previews stand alone — no real network.

## UI tests — XCUITest
- Identify elements by `accessibilityIdentifier` (NOT visible label — labels localize).
- Disable animations in test setup (`UIView.setAnimationsEnabled(false)`).
- Use for: code-owned regression flows on simulator/device.

## E2E — Maestro
- `.yaml` flows in `.maestro/` (in-repo, checked in).
- Use for: smoke (cold launch + login + key screen), agent regression, post-deploy verification.

## Fakes over mocks at boundaries
- Define protocol at each boundary; provide `FakeFoo` conforming type for tests.
- Fakes record calls into a property the test inspects; not "verify expectations" APIs.
- Fakes encode the same contract as the real (invariants, ordering, idempotency).

## Time — inject a Clock
- ANY time-dependent code takes a clock abstraction (iOS 17+ `Clock` protocol, or define your own).
- Production: `ContinuousClock()` / `SystemClock()`. Tests: `TestClock` that advances on command.
- Eliminates `sleep`-based polling.


> When a rule is unclear, read `agents/docs/ios/ios-testing-details.md`.
