# iOS Client — Status

## What this is

A native iOS client that speaks the same WebSocket protocol as the web
client, built as a thin SwiftUI consumer of the shared KMP SDK
(`shared/mobile-sdk`), linked as a SKIE-processed XCFramework. Targets
Swift + SwiftUI. Project is generated from `ios/project.yml` via xcodegen
(the `.xcodeproj` is gitignored — run `xcodegen generate` before `xcodebuild`).

## Current state

**Phase 0 (Foundation) complete.** The app builds for the `iPhone 14 Pro
(26.5)` simulator, launches, and renders the SDK greeting via
`MobileSdkKit.shared.greeting()` (SKIE exposes the Kotlin `MobileSdk` object
as `MobileSdkKit`). The view carries `accessibilityIdentifier`
`foundation-greeting`. A debug-scoped ATS exception covers `localhost` for
later WSS dev.

Working:
- SwiftUI app consuming the shared SDK through SKIE (`import MobileSdk`).
- Agent dev-loop validated: xcodegen + `xcodebuild` + `xcrun simctl` + **Maestro**
  (XCUITest/WDA, no idb) driving the 26.5 sim.
- Reaches the local gateway at `localhost:8888`.

Not yet built (later phases): real SDK wiring — WS transport (P1), chat UI (P2),
voice (P3), push (P4). See `docs/superpowers/plans/` and `qa/mobile/README.md`
(incl. P2 carry-forwards: Swift 6 xcconfig, `#Preview`, config-conditional
XCFramework path). E2E contract: `qa/mobile/foundation-matrix.md`.
