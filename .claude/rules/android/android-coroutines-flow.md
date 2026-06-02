---
description: Coroutines and Flow -- StateFlow/SharedFlow, lifecycle-aware collection, dispatcher discipline, Room/DataStore as Flow sources.
paths:
  - "android/**"
---

# Coroutines and Flow

Flow is Kotlin's cold-stream primitive; `StateFlow`/`SharedFlow` are the hot variants.

## Cold vs hot

- `Flow<T>` — cold; producer runs per collector.
- `StateFlow<T>` — hot, holds one value, replays to new collectors. Use for UI state.
- `SharedFlow<T>` — hot, configurable replay/buffer. Avoid for one-shot events — drops under lifecycle-paused collection. Use Channel or events-in-state instead.

## Lifecycle-aware collection

- Compose: `flow.collectAsStateWithLifecycle()` (requires `lifecycle-runtime-compose`).
- Fragment/Activity: `lifecycleScope.launch { repeatOnLifecycle(STARTED) { flow.collect { } } }`.
- NEVER collect on `GlobalScope`.

## Dispatchers + cancellation

- `IO` blocking I/O; `Default` CPU; `Main.immediate` UI. Pick at the boundary (`withContext`).
- Long CPU loops: `ensureActive()`. NEVER catch + swallow `CancellationException`.

## Backpressure + joining

- `buffer(n)` decouples; `conflate()` drops intermediates; `debounce(t)` / `sample(t)` for search/scroll.
- `combine(a, b)` emits on either change; `flatMapLatest` cancels in-flight on new upstream.

## Data sources expose Flow (G5)

- Room DAOs return `Flow<T>`; DataStore exposes `data: Flow<Preferences>` / `data: Flow<T>`.
- Observe both with `collectAsStateWithLifecycle`; ViewModel exposes via `stateIn(WhileSubscribed(5_000))`.


> When a rule is unclear, read `agents/docs/android/android-coroutines-flow-details.md`.
