---
description: Architecture -- blackbox SDK -> stateless repos -> usecases -> thin per-route ViewModel -> Compose.
paths:
  - "android/**"
---

> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/usecase layer live in the shared modules — do NOT re-implement them here.

# Architecture

Layering: blackbox SDK → stateless repositories → usecases → one thin ViewModel per screen → Compose. The ViewModel never touches the SDK or a repository directly — only usecases.

## The shape

- A screen's ViewModel is THIN: it holds per-screen + view-local state, invokes usecases, and exposes one read-only hot state-holder. Business logic that combines or transforms multiple sources lives in a usecase, not the VM.
- The VM is scoped to its route destination and is rebuilt when the route argument changes — that recreation is how per-screen state is cleaned, not an in-place reset.
- Usecases are resolved from the connection scope (which outlives the screen). Per-screen caches (e.g. an optimistic outbox) are VM-local state.
- Reads flow in through usecases; commands go out through usecases.

## Command surface — plain methods OR dispatch(Intent)

- Simple command surfaces expose plain VM methods. Form / multi-field screens use the MVI triple — UI state + a sealed Intent + a single exhaustive `dispatch` reducer. Don't force `dispatch(Intent)` onto a two-method command VM.
- Composables never mutate state — they call VM methods or dispatch. Read state via lifecycle-aware collection.

## One-shot events — NOT a buffered SharedFlow

Lifecycle-paused collection drops emissions.
- Primary: model the event in UI state; the composable acknowledges after showing.
- Secondary: a buffered Channel exposed as a receive-flow — guarantees delivery.

## Navigation — typed routes

- Top-level navigation is a typed route graph (see the navigation rule), NOT a state-gate swap. A transient overlay may stay in-screen; promote to a route only when it needs a back-stack entry.
- Gate the entry on auth, not connection status — a transport drop must not change the screen.

## What goes where

- Multi-source combine / transform / event-fold: a usecase (shared).
- Per-screen + view-local state, action dispatch: the ViewModel.
- Datasource mapping (data in, data out): a stateless repository.
- Theme, layout, formatting: the composable.

> When a rule is unclear, read `agents/docs/android/android-architecture-mvi-details.md`.
