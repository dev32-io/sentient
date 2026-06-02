# iOS Client

Native iOS client for Sentient. Thin SwiftUI consumer of the shared KMP SDK (`shared/mobile-sdk`), linked as a SKIE-processed XCFramework.

## MANDATORY — Read Rules First

Rules live at the repo root. Load ALL of these before modifying iOS source:

- Cross-cutting: `.claude/rules/*.md`
- iOS UI app: `.claude/rules/ios/*.md`
- Shared KMP SDK (consumed by this app): `.claude/rules/mobile-sdk/*.md`
- Mobile cross-platform: `.claude/rules/mobile/*.md`

Details: `agents/docs/ios/*-details.md`, `agents/docs/mobile-sdk/*-details.md`, `agents/docs/mobile/*-details.md`.

## Stack

- Language: Swift + SwiftUI (iOS 17+)
- Transport + session/audio FSM: `shared/mobile-sdk` KMP module, exposed as a SKIE-processed XCFramework (`MobileSdk`). The iOS app does NOT own WebSocket, reconnect, or session state — those live in the SDK. SKIE bridges `Flow`→`AsyncSequence`, `suspend`→`async`, sealed classes→Swift enums.
- Build: xcodegen (`project.yml`) + `xcodebuild`. The `.xcodeproj` is gitignored — run `xcodegen generate` before `xcodebuild`.
- Automation: Maestro (XCUITest/WDA, no idb) for E2E; `xcrun simctl` for install/launch/screenshot/push.
- Push: APNs (direct, no Firebase) — Phase 4

STT and TTS are server-side (gateway). No on-device wake word in v1.

## Status

**Phase 0 (Foundation) complete.** App builds for `iPhone 14 Pro (26.5)` simulator, launches, and renders the SDK greeting via `MobileSdkKit.shared.greeting()`. Agent dev-loop validated (xcodegen + `xcodebuild` + `simctl` + Maestro). Reaches local gateway at `localhost:8888`.

Later phases: P1 WS transport, P2 text chat UI, P3 voice, P4 push. See `STATUS.md` and `docs/superpowers/plans/`.

## Commands

    xcodegen generate                            — Regenerate .xcodeproj from project.yml
    xcodebuild build -scheme Sentient …          — Build for simulator
    xcrun simctl boot "iPhone 14 Pro"            — Boot simulator
    xcrun simctl install booted <app.app>        — Install
    xcrun simctl launch booted <bundle-id>       — Launch
    xcrun simctl io booted screenshot out.png    — Screenshot
    maestro test .maestro/<flow>.yaml            — Run Maestro E2E flow
