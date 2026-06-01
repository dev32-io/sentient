---
description: iOS MVVM -- @Observable ViewModel, navigation-as-state, layer boundaries.
paths:
  - "ios/**"
---

> SCOPE (sentient KMP): this rule governs the iOS **UI app only** (ios/**).
> WebSocket transport, session/audio FSM, connectors, reconnect, and logging live in
> `shared/mobile-sdk` (commonMain) — see `.claude/rules/mobile-sdk/`. The iOS app is a
> thin SwiftUI consumer of the SDK; do NOT re-implement transport/state here.

# MVVM Architecture

Single state-and-navigation owner per screen.

## Three roles
- `Model` — `struct` / `enum` describing the domain; no SwiftUI, no I/O, `Sendable`.
- `View` — SwiftUI; reads VM state, dispatches user actions as method calls; no business logic.
- `ViewModel` — `@Observable @MainActor final class`; owns state + async lifecycle.

## ViewModel shape
- `@Observable final class ScreenViewModel` (iOS 17+); `ObservableObject` only as legacy.
- One state property the view reads; `@MainActor` at class level when UI-bound.
- Async work via `Task { }` from `init` or view-facing methods.

## Navigation — state
- `Route` enum drives `NavigationStack`, `.sheet(item:)`, `.fullScreenCover(item:)`.
- VM mutates `route`; view observes + renders.
- Modeling as state: deep links work, back works, snapshot tests reproducible.

## Layer boundaries
- `View → ViewModel → UseCase → Repository → Service`.
- View calls ONLY ViewModel methods.
- ViewModel calls UseCase (or, for simple screens, Repository directly — pick one and stay).
- UseCase orchestrates one user-goal; Repository abstracts a data source; Service is the concrete transport (URLSession, SwiftData, Keychain).
- A view reaching past its VM into a Repository breaks the layer model.

## What goes where
- Business logic / validation / derivations: ViewModel / UseCase.
- I/O: Repository behind a protocol; VM sees the protocol only.
- Theme / layout / formatting: View.
- Navigation: ViewModel state; view binds.

See `agents/docs/ios/ios-architecture-mvvm-details.md`.
