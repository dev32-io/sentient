# Task Brief: Integrate iOS Rive identity, readiness-gated startup, native shell, and History

## Contribution Goal

Package the canonical identity as an iOS-owned resource, expose exactly three semantic states, and refresh startup/navigation/History while preserving native lifecycle and session behavior.

## Boundary — Included

- Pinned Rive iOS package/resource wiring, native SwiftUI identity wrapper/fallback, state mapping, startup readiness coordinator, launch-to-root transitions, title shell, History drawer/list/search/context actions, native navigation/focus/accessibility behavior.

## Required Work

- 1. Add official https://github.com/rive-app/rive-ios version 6.22.0 and its RiveRuntime product through ios/project.yml/XcodeGen; do not hand-edit the generated .xcodeproj. Copy sentient-avatar.riv into an iOS-owned resource path and copy/retain a static fallback. Production code must not load/import design/prototype/**. Add a build-time/unit checksum assertion against SHA-256 bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b.
- 2. Implement a thin RiveSentientIdentity/SentientMark replacement using bundled loading, artboard SentientAvatar, state machine Avatar, triggers toIdle/toThinking/toResponding, Boolean reducedMotion, and exactly idle/thinking/responding. New state requests converge to latest state; SwiftUI owns sizing/lifecycle/labels/fallback only and must not recreate 250ms choreography.
- 3. Map cognition/acting/processing/startup to thinking and streaming text/assistant speech to responding. Voice listening/capture cannot set identity mode. Rive load failure shows the copied static canonical mark plus native semantic status and never blocks the app.
- 4. Replace the time-only splash with a root readiness coordinator prebound to thinking before first visible frame. Reveal only when both 1500ms elapsed and active root is resolved: configuration check can show setup; initial user-list success/empty/actionable error can show login; authenticated session/chat shell can show usable content or actionable recovery. Readiness does not require network success and never animates indefinitely over failure.
- 5. Make the generated/native launch presentation visually continuous with the first thinking frame as far as iOS launch-screen constraints allow, with no idle flash. Add an injectable monotonic clock/readiness source for deterministic tests.
- 6. Preserve one native outer NavigationStack, native titles/back behavior, safe areas, route path/session identity, logout/auth-expiry teardown, and settings navigation. Do not create nested stacks or custom web-style navigation.
- 7. Refresh ChatTitleBar and History drawer/panel using iOS common components: loading/empty/search-no-match/stale/error+retry/active rows, account header, new chat, selection, scrim/edge swipe/drag dismissal, long-press context menu, native rename alert/text field, native destructive delete alert, and focus/accessibility. Preserve existing session APIs and keep dormant Route.history behavior explicit.
- 8. Add tests for checksum/fallback, exact state mapping/reduced motion/latest state, fast/slow/error startup clocks and no idle flash, correct root reveal, native navigation/session teardown, History states/search/new/select/rename/delete, drawer gestures, and larger Dynamic Type.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Sole owned integration seams are ios/project.yml, RootView.swift, SplashOverlay.swift, Nav/UserSessionHost.swift, Chat/brand/SentientMark.swift, Chat/drawer/{SideDrawer,ChatTitleBar}.swift, ios/App/History/**, and minimal readiness hooks in AuthViewModel/UserSession/ChatViewModel.
- Current splash is time-only for 2.0s and renders a static ignored mode. Required startup is thinking immediately, for at least 1500ms and until active-root readiness resolves, then usable content or actionable failure.
- Canonical Rive reference bytes/manifest live under design/prototype/foundation-components/assets/avatars. They are task context/reference only; the app must package an iOS-owned copy with identical bytes.

## Boundary — Excluded

- Chat messages/composer/task shelf internals
- Settings/Calendar page migration
- Rive source edits or prototype runtime imports
- New session rename/delete APIs
- Android UI work

## Interfaces and Dependencies

- Consumes iOS foundation components and packages a byte-identical platform-owned Rive copy.
- Produces a three-state native identity API, startup readiness contract, refreshed native shell/title/History, and readiness hooks consumed by ios-chat-composer.
