---
description: Swift Concurrency -- async/await, structured tasks, Sendable, @MainActor, Swift 6 strict mode.
paths:
  - "ios/**"
---

# Swift Concurrency

Structured concurrency only buys safety if you don't routinely break it.

## Swift 6 strict mode — mandatory
- xcconfig: `SWIFT_VERSION = 6.0`; `SWIFT_STRICT_CONCURRENCY = complete`.
- Swift 6 is the language baseline; the compiler catches data races at build time.

## async/await over completion handlers
- New code: `async` functions only.
- Bridge legacy via `withCheckedThrowingContinuation` at the boundary; never propagate completion handlers up.

## Tasks — structured by default
- `Task { ... }` from sync context inherits actor + priority.
- `Task.detached` ONLY when you genuinely need to drop parent context.
- Child tasks via `async let` / `withTaskGroup`; cancel with parent. Do NOT store `Task` long-term unless cancellation is explicit.

## Cancellation / AsyncSequence
- `try Task.checkCancellation()` in long loops; cancellation is a request, not a guarantee.
- `AsyncStream<T>` / `AsyncThrowingStream<T, Error>` for unbounded streams; callers `for await`. Prefer over Combine.

## Sendable — strict
- Types crossing actor boundaries are `Sendable`; closures need `@Sendable`.
- Reference types: `final class ... : Sendable` (immutable state) or argued `@unchecked Sendable`.

## `@MainActor` — UI-touching code
- UI properties/methods `@MainActor`; compiler enforces statically.
- ViewModels with UI-bound state are `@MainActor` at class level.

## Actors — shared mutable state
- `actor` for any state shared across concurrent contexts; serializes access.
- Avoid storing UI types inside non-`@MainActor` actors.


> When a rule is unclear, read `agents/docs/ios/swift-concurrency-details.md`.
