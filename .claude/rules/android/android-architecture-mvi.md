---
description: MVI -- UiState/Intent/Effect, events-in-state primary, Channel secondary, type-safe Navigation.
paths:
  - "android/**"
---

> SCOPE (sentient KMP): this rule governs the Android **UI app only** (android/**).
> WebSocket transport, session/audio FSM, connectors, reconnect, and logging live in
> `shared/mobile-sdk` (commonMain) — see `.claude/rules/mobile-sdk/`. The Android app is a
> thin Compose consumer of the SDK; do NOT re-implement transport/state here.

# MVI Architecture

Every screen has a single source of truth and a single mutation entry point.

## Three types per screen

- `UiState` — `data class` (or sealed for shape-distinct cases) holding everything the view renders.
- `Intent` — `sealed interface` of user actions + external events.
- One-shot events — events-in-state primary; `Channel<Effect>` only when state can't model it.

## ViewModel shape

- `state: StateFlow<UiState>` via `_state.asStateFlow()`.
- `dispatch(intent: Intent): Unit` — only mutation entry point.
- Reducer is exhaustive `when (intent) { ... }` over sealed type; side work in `viewModelScope.launch`.

## One-shot events — DO NOT use SharedFlow with `extraBufferCapacity=1`

Lifecycle-paused collection drops emissions.
- Primary: model the event in `UiState` (`toast: String?`); composable dispatches `Consumed.Toast` after showing.
- Secondary: `Channel<Effect>(Channel.BUFFERED)` exposed as `.receiveAsFlow()`. Channel guarantees delivery.

## Consumption + navigation

- Read state: `collectAsStateWithLifecycle()`. Composables MUST NOT mutate state; they `dispatch(Intent)`.
- Type-safe nav (G7): Navigation Compose 2.8+ with `@Serializable` route objects + `composable<Route> { entry.toRoute<Route>() }`.

## What goes where

- Business logic, validation: reducer / VM-called `suspend` functions.
- I/O: repository / use-case behind interface.
- Theme, layout, formatting: composable.
- Navigation: trigger via state (pending route) or `Channel<Effect>`.

See `agents/docs/android/android-architecture-mvi-details.md`.
