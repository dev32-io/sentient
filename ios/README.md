# Sentient — iOS client

Native iOS client for Sentient (the family voice assistant). A **thin SwiftUI UI over the
shared KMP SDK** (`shared/mobile-sdk`), linked as a SKIE-processed **XCFramework**
(`MobileData`, which re-exports `mobile-sdk`). Transport, session/audio state, reconnect,
opus, and logging live in the SDK — this app is UI + scopes + navigation only. STT/TTS are
server-side; no on-device wake word in v1.

- **Project:** `ios/SentientApp.xcodeproj` · **scheme:** `SentientApp`
- **Version:** `0.0.1` (`CFBundleShortVersionString` in `App/Info.plist`)
- **Deployment target:** iOS 18 (some views carry iOS-17 fallbacks).

## Architecture

Layering — dependencies flow inward only:

```
blackbox SDK (shared/mobile-sdk)
  → stateless repositories            (shared/mobile-data .data)
    → usecases (combine/transform)    (shared/mobile-data .usecase)
      → one thin @Observable/@StateObject ViewModel per screen (this app)
        → SwiftUI
```

- **ViewModels are thin** — per-screen + view-local state only; combine/transform logic
  lives in shared usecases (bridged Kotlin `Flow` consumed as `AsyncSequence`). A VM never
  touches the SDK or a repository directly.
- **A conversation is a route.** The root `ChatView` is keyed `.id(activeSessionId)` inside a
  `NavigationStack`; changing the active session rebuilds the view → a fresh `@StateObject`
  VM. That recreation IS the per-screen cleanup boundary — never reset state in place.
- **Three scopes:** App (token/backend/display name) · **Connection** (`UserSession`
  `@StateObject` — the KMP SDK + `ChatComponent`, held ABOVE the `NavigationStack`, alive
  while authenticated so navigation never drops the socket) · Screen (the per-route VM).
- **Presence:** a `scenePhase` relay (`UserSessionHost`) forwards foreground/background with a
  cold-start skip. Background keeps the socket; foreground sends a one-shot liveness probe and
  reconnects only if it's dead.
- **Offline-first:** sends are optimistic via an in-memory outbox flushed on ready.

## Layout

```
ios/App/
  SentientApp / RootView / Nav/          @main, auth gate, UserSessionHost (scenePhase)
  Session/UserSession.swift              connection scope over the KMP IosUserSession
  Chat/                                  ChatView/ChatViewModel + composer, message list,
                                         bubbles, tool pills, drawer, banners, voice, brand
  History/                               HistorySidePanel + HistoryViewModel
  Theme/                                 Dusk tokens (mirrors the shared design tokens)
  SDK/                                   AppConfig + KMP bridge glue
```

## Build & run

The app links the `MobileData` XCFramework, so rebuild it after any change in
`shared/mobile-sdk` or `shared/mobile-data`:

```bash
source scripts/env.sh
./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework   # (re)build the framework

xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' build       # build the app
```

**Always build SIGNED.** Never pass `CODE_SIGNING_ALLOWED=NO` — it strips the keychain
entitlement and breaks WebSocket auth on device. Point the app at a gateway via the
`GatewayWSURL` build setting / in-app backend resolution (local default: `deploy/macos/`).

## Testing

- **Unit** (Swift Testing preferred, XCTest legacy): VMs, use-cases, repositories with fake
  transport — never real network. `async` tests are first-class; inject a `Clock`, never sleep.
- **UI regression:** XCUITest (target elements by `accessibilityIdentifier`).
- **E2E:** checked-in **Maestro** `.yaml` flows via `xcrun simctl` (cold launch → login → chat
  → switch → logout). Some flows have known iOS-beta-simulator harness gaps — flagged in the
  testing-knowledge docs, not silently skipped.

## Rules

Conventions live in the repo root `.claude/rules/ios/*.md` (Swift, SwiftUI, concurrency,
Combine, MVVM, testing) and the cross-platform `.claude/rules/mobile/*.md` (navigation,
lifecycle, offline). Read those before changing this app.
