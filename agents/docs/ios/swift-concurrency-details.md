# Swift concurrency details

This file expands `.claude/rules/ios.md`. Read it when concurrency guidance is unclear.

## Use structured, owned work

Prefer `async let`, task groups, and async methods so cancellation follows scope. A `Task {}` is appropriate at a synchronous UI boundary, but retain the handle when work outlives the call or needs cancellation. Cancel collection/search tasks when their owning ViewModel or session ends. Avoid `Task.detached` unless escaping the inherited actor is an intentional, documented requirement.

`@MainActor` ViewModels may update UI state after an awaited call; actor isolation resumes on the main actor. Keep shared mutable state in an actor or another explicit isolation boundary, and make value types crossing concurrency boundaries `Sendable` when appropriate. Avoid adding `@unchecked Sendable` merely to silence diagnostics.

## Shared Kotlin streams

SKIE's async-sequence bridge is the primary iOS path for Kotlin `Flow`:

```swift
for await model in component.observeChat.invoke(pending: pendingFlow) {
    handle(model)
}
```

Store and cancel the consuming task. Use Combine only where an existing framework API already exposes a publisher; do not convert shared flows to Combine just for consumption. Wrap legacy completion handlers once at their boundary with a checked continuation.

The repository does not currently document a verified project-wide Swift strict-concurrency setting. Do not assume or prescribe one; follow the isolation and compiler settings actually present in the target when changing code.
