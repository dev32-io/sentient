---
description: iOS MVVM -- blackbox SDK -> stateless repos -> usecases -> thin per-route observable VM -> SwiftUI.
paths:
  - "ios/**"
---

> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/usecase layer live in the shared modules (a bridged framework) — do NOT re-implement them here.

# MVVM Architecture

Single state-and-navigation owner per screen. Layering: blackbox SDK → stateless repositories → usecases → one thin ViewModel per screen → SwiftUI. The ViewModel reaches data only through usecases, never the SDK or a repository directly.

## Three roles

- Model — value-type domain; no UI, no I/O, `Sendable`.
- View — SwiftUI; reads VM state, dispatches actions as method calls; no business logic.
- ViewModel — `@MainActor`, THIN: per-screen + view-local state, invokes usecases, exposes one published state. No combine/transform logic (that's a usecase).

## ViewModel shape

- A per-screen observable state-holder (`@Observable` or `ObservableObject` + `@Published`), owned by its view and SCOPED TO THE NAVIGATION DESTINATION — a new route argument rebuilds the view's identity, giving a fresh VM and clean per-screen state. That recreation is the cleanup boundary; never reset state in place.
- One state property the view reads; `@MainActor` at class level. Async work via tasks from `init` or view-facing methods, cancelled on teardown.

## Consumption — usecases

- The VM collects usecase flows (bridged Kotlin `Flow` as an `AsyncSequence` — iterate with `for await`, no cast) and folds them into its published state. Fold result envelopes exhaustively; no `default` that swallows failure.
- Business logic lives in usecases. A view reaching past its VM, or a VM reaching past its usecases into the datasource, breaks the model.

## Navigation — typed routes

- Top-level navigation is a typed route graph (see the navigation rule). The connection scope lives ABOVE the graph so navigation never drops the socket. A transient surface (settings sheet, history drawer) may stay an in-screen overlay; promote to a route when it needs its own back-stack entry.
- Gate the entry on auth, not transport status.

## Scopes

- App scope: app-lived non-connection state (backend resolution, token store, display name, nav gates).
- Connection scope: the transport + usecase graph, held above the route graph, alive while authenticated, surviving navigation.
- Screen scope: the per-route VM + view-local state.

> When a rule is unclear, read `agents/docs/ios/ios-architecture-mvvm-details.md`.
