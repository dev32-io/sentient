# Authenticated Mobile Session Lifecycle — Details

This file expands `.claude/rules/mobile-shared.md`. There is no shared `MobileSession` abstraction in current source. Android `UserSessionManager` and iOS `UserSession`/KMP `IosUserSession` are the platform owners of the same authenticated user/connection lifetime.

## Shared composition boundary

`ChatComponent` is hand-written KMP composition over one `SentientSdk`:

```kotlin
class ChatComponent(private val sdk: SentientSdk, ...) {
    val conversationRepository = SdkConversationRepository(sdk)
    val sessionsRepository = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    val observeChat = ObserveChatUseCase(conversationRepository, clock)
    val sendMessage = SendMessageUseCase(conversationRepository, sdk.currentSessionId)
    val switchConversation = SwitchConversationUseCase(sessionsRepository)

    suspend fun connect() = sdk.connect()
    fun ensureConnected() = sdk.ensureConnected()
    fun disconnect(clearSession: Boolean = true) = sdk.disconnect(clearSession)
}
```

The repositories are stateless SDK passthroughs. Event folding and multi-source combination are cold, collection-owned usecase work. Per-conversation mutable optimistic state belongs to the native chat VM's `OutboundCache`, not to `ChatComponent`.

## Android owner

`UserSessionManager` is a Koin singleton whose contents are authenticated-scope resources, not process-global SDK state. It lazily builds one SDK/session scope plus `ChatComponent` and `SettingsComponent` for an explicit authenticated user id. Navigation and chat route recreation reuse that component. Logout, terminal auth, account replacement, and backend replacement tear it down before another authenticated scope is built.

`ChatViewModel` receives the current `ChatComponent` and route `sessionId`. It switches/new-creates the active conversation and owns screen collectors/outbox only; `onCleared()` does not disconnect the authenticated connection.

## iOS owner

`UserSessionHost` holds Swift `UserSession` above the authenticated `NavigationStack`. `UserSession` owns one KMP `IosUserSession`, which builds one SDK/session scope and exposes its `ChatComponent` and `SettingsComponent`. Route-keyed `ChatView` recreation creates a fresh thin `ChatViewModel` while retaining the connection owner.

`UserSession.shutdown()` and the explicit logout/auth-expiry/replacement paths close the KMP boundary before auth state is cleared or replaced. A chat VM `deinit` cancels only that VM's collection tasks.

## Foreground/background

Routine backgrounding keeps the authenticated connection scope and socket; it does not destroy the component or outbox. Foreground after a real background transition uses the existing engagement/liveness path: a healthy READY socket is probed, and a dead or non-ready socket reconnects. The initial foreground event is skipped because the owner already opens the connection.

A process kill is different: the SDK timeline, resume cursor default, and VM-owned outbox are in memory, so they do not survive cold relaunch. Authoritative conversation history is refetched from the gateway.

## Teardown invariants

- Authenticated ownership survives navigation and conversation changes.
- Route recreation resets per-conversation UI state without disconnecting the SDK.
- Logout/replacement tears down the old authenticated scope before constructing its successor.
- No screen, ViewModel, repository, or process-global helper may create a second SDK.
- `ChatComponent.close()` is currently an idempotent composition hook; platform owners disconnect and cancel their SDK scope.
