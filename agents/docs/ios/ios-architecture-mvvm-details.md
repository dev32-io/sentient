# iOS architecture and MVVM details

This file expands `.claude/rules/ios.md`. Read it when the architecture rule is unclear.

## Shipped shape

- `UserSessionHost` is the authenticated root. It owns a `UserSession` for the authenticated lifetime and places it above the `NavigationStack`.
- `UserSession` owns one KMP `IosUserSession`, exposing its shared `ChatComponent` and settings component. Navigation, history, and conversation changes must not recreate that connection scope.
- Authenticated destinations are the closed `Route` graph registered on `NavigationStack`. The chat root is keyed by its route/conversation identity so a changed conversation gets a fresh thin `ChatViewModel`.
- ViewModels coordinate screen state and call the shared component/usecases; transport, repositories, reconnect, and session state stay in shared code. Leaf views take state and closures.
- Both `ObservableObject`/`@Published` and `@Observable` are used intentionally. Match the existing feature rather than migrating observation models for consistency alone.

## Shared stream interop

SKIE exposes Kotlin `Flow` as an async sequence. Consume it directly:

```swift
for await model in component.observeChat.invoke(pending: pendingFlow) {
    apply(model)
}
```

Fold SKIE sealed results with the generated enum helpers such as `onEnum(of:)`. Do not introduce a Combine bridge for a shared Kotlin stream; Combine remains valid at an existing framework publisher boundary. Preserve ownership: store long-lived collection tasks, cancel them when the owning screen/session ends, and avoid retain cycles.

## Lifecycle

`scenePhase` is relayed by `UserSessionHost`. The current iOS background hook intentionally keeps the socket and connection scope alive; foreground performs the established liveness/resume path after a real background transition. The initial active event is skipped because `UserSession` already opens on creation. Logout shuts down `UserSession` before clearing the auth gate.
