# iOS architecture and MVVM details

This file expands `.claude/rules/ios.md`. Read it when the architecture rule is unclear.

## Shipped shape

- `UserSessionHost` is the authenticated root. It owns a `UserSession` for the authenticated lifetime and places it above the `NavigationStack`.
- `UserSession` owns one KMP `IosUserSession`, exposing its shared `ChatComponent` and settings component. Navigation, history, and conversation changes must not recreate that connection scope.
- Authenticated destinations are the closed `Route` graph registered on `NavigationStack`. The chat root is keyed by its route/conversation identity so a changed conversation gets a fresh thin `ChatViewModel`.
- ViewModels coordinate screen state and call the shared component/usecases; transport, repositories, reconnect, and session state stay in shared code. Leaf views take state and closures.
- Both `ObservableObject`/`@Published` and `@Observable` are used intentionally. Match the existing feature rather than migrating observation models for consistency alone.

## Startup, authentication, and deep links

Cold launch always starts covered by the splash. `AppConfig` validates complete stored credentials through the shared `AuthClient.me` before `RootView` mounts `UpdateGate` or `UserSessionHost`. Success persists the refreshed token and server identity first; invalid credentials return to login. Network/server failure retains credentials and shows an actionable retry root, not an authenticated session or an automatic logout. Successful interactive login enters directly; ordinary foreground and warm deep links do not repeat the splash or startup validation.

A notification/deep-link session ID is pending navigation intent, never authorization. After login, `UserSessionHost` uses the existing acknowledged session-activation path; the gateway resolves the target in the authenticated principal's store. Forced reauthentication preserves the latest intent for the same backend/account. Explicit logout and account/backend replacement discard it. The navigation fence comes from the authenticated session, independently of any retiring push-binding owner.

The authenticated host observes shared `ConnectionState.authExpired` across every screen. Session-owned REST clients feed the same signal for current-bearer 401 responses; stale tokens, closed owners, wrong-PIN domain 401s, unavailable targets, and transport failures do not trigger this interceptor. Auth ending immediately blocks protected interaction, accessibility, navigation, and recovery. Push unlink preparation has a bounded wait before one-shot teardown/auth clearing, with late-completion fencing and a warning/retry path on failure.

`UNUserNotificationCenterDelegate` uses explicit completion-handler callbacks completed on `MainActor`. Queuing an intent must not wait for login or network work. An async delegate's implicit Objective-C completion can execute off-main even if navigation mutation itself used `MainActor.run`.

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
