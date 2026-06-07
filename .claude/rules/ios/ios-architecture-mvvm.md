---
description: iOS MVVM -- ObservableObject+@StateObject VM, VM->repo via session, boolean Group-gate nav.
paths:
  - "ios/**"
---

> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/repository layer live in the shared modules (a SKIE-bridged XCFramework) — do NOT
> re-implement them here.

# MVVM Architecture

Single state-and-navigation owner per screen. Layering: blackbox SDK → repositories on the chat session → one ViewModel per screen → SwiftUI. Views reach the SDK only through repositories.

## Three roles

- Model — `struct`/`enum` domain; no SwiftUI, no I/O, `Sendable`.
- View — SwiftUI; reads VM state, dispatches actions as method calls; no business logic.
- ViewModel — `@MainActor final class`; owns one published state + the session lifecycle.

## ViewModel shape (shipped)

- Standardize on `ObservableObject` + `@Published`, held as `@StateObject` and propagated via `@EnvironmentObject` (composes across `@StateObject` boundaries). `@Observable` is fine for a self-contained leaf VM but is not the app-wide default.
- One state property the view reads; `@MainActor` at class level.
- Async work via `Task { }` from `init` or view-facing methods.

## Consumption — repositories via SKIE

- A screen VM collects the session's repository flows with `for await`; SKIE exposes a Kotlin `Flow` as an AsyncSequence — iterate directly, no cast.
- Fold the result envelope exhaustively (`onEnum(of:)`) into the published state. No `default` that swallows failure.
- VMs talk to repositories through the session; there is NO UseCase layer. A view reaching past its VM into a repository breaks the model.

## Navigation — boolean gate (shipped), not a router

- Top-level nav is a SwiftUI `Group` gate on app-config booleans (configured → setup, authed → chat, else login). No `Route` enum / `NavigationStack(path:)` at the root. Settings + history are sheets/overlays within the in-session state.
- Gate on auth, not transport status. A typed-route stack is only for a future multi-destination need.

## App-scope vs session-scope

- An app-scoped config object (an `@EnvironmentObject`) holds app-lived NON-SDK state: backend resolution, token store, display name, the nav gates.
- The SDK + repositories live ONLY inside the chat-scoped session, held by the chat VM's `@StateObject`; the VM's `deinit` closing the session is the SINGLE teardown path.

> When a rule is unclear, read `agents/docs/ios/ios-architecture-mvvm-details.md`.
