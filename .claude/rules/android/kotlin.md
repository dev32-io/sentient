---
description: Kotlin idioms -- immutability, null safety, structured concurrency, sealed types, Result at boundaries.
paths:
  - "android/**"
---

# Kotlin

Kotlin's type system pushes failure modes from runtime to compile time. The idioms below preserve that property.

## Immutability — first

- `val` over `var`; `List`/`Map`/`Set` over their mutable variants.
- `data class` for records; update with `.copy()`.

## Null safety — no `!!`

- NEVER use `!!`. Prefer `?.`, `?:`, smart-cast.
- Invariant violations: `requireNotNull(x) { "..." }` / `checkNotNull(x) { "..." }`.
- External input returns `T?`; let caller decide.

## Sealed types — closed sums

- `sealed interface` / `sealed class` for "one of a fixed set" with exhaustive `when`.
- `enum class` for plain tags only.

## Structured concurrency + dispatchers

- Launch from `viewModelScope`, `lifecycleScope`, or a scope you own. NEVER `GlobalScope.launch`.
- Cooperate with cancellation: `ensureActive()` in long CPU loops; never swallow `CancellationException`.
- Dispatcher at the boundary: `Dispatchers.IO` I/O, `Dispatchers.Default` CPU, `Dispatchers.Main.immediate` UI.

## Result at boundaries + extensions

- Expected failure: `Result<T>` or domain sealed class. Bugs / invariant violations: throw.
- Public boundary signatures declare the failure shape.
- Extensions: additive, stateless helpers in topical files (`StringExtensions.kt`). No fields — use a class if you need state.

See `agents/docs/android/kotlin-details.md`.
