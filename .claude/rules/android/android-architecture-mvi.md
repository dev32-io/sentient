---
description: Architecture -- blackbox SDK -> repos -> per-screen ViewModel (one UI state), state-gate nav.
paths:
  - "android/**"
---

> SCOPE: governs the UI app only. Transport, session/audio FSM, reconnect, logging, and the
> data/repository layer live in the shared modules — do NOT re-implement them here.

# Architecture

Layering: blackbox SDK → repositories → one ViewModel per screen → Compose. Every screen owns ONE state-holder; the SDK is never touched from a composable or ViewModel directly — only through repositories on the chat session.

## The shape

- A screen's ViewModel collects repository flows (the result envelope) and folds them into a single UI state, exposed as a read-only hot state-holder.
- Chat/history VMs are built from the chat-scoped session and keyed by session identity; clearing the VM tears the session down.
- The app-scoped presence relay drives the session's foreground/background ops. Nothing chat-related is app-scoped.
- Reads flow in through repositories; commands go out through the session/SDK.

## Command surface — plain methods OR dispatch(Intent)

- Simple command surfaces expose plain VM methods. Form / multi-field screens use the MVI triple — UI state + a sealed Intent + a single exhaustive `dispatch` reducer. Don't force `dispatch(Intent)` onto a two-method command VM.
- Composables never mutate state — they call VM methods or dispatch. Read state via lifecycle-aware collection.

## One-shot events — NOT a buffered SharedFlow

Lifecycle-paused collection drops emissions.
- Primary: model the event in UI state; the composable acknowledges after showing.
- Secondary: a buffered Channel exposed as a receive-flow — guarantees delivery.

## Navigation — state-gate, not a router

- Top-level navigation is a state-based composable swap gated on derived booleans, NOT a route graph. Overlays (settings, drawer) live within the in-session state, not as stack destinations.
- Gate on auth, not connection status — a transport drop must not change the screen.
- A typed route graph is future work; don't add a navigation library until a real multi-destination stack exists.

## What goes where

- Business logic / validation: reducer or VM suspend functions.
- I/O + SDK access: repositories, behind the result envelope.
- Theme, layout, formatting: composable.

> When a rule is unclear, read `agents/docs/android/android-architecture-mvi-details.md`.
