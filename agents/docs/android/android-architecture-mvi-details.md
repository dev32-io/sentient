# Android architecture details

This expands `.claude/rules/android.md`. The app uses route-scoped state holders over shared mobile components; it is not a second domain or transport layer.

## Connection and DI

Koin is the production DI mechanism. `SentientApp` starts the graph from `di/AppModule.kt`. `UserSessionManager` is a Koin singleton for the authenticated user: it lazily builds one `ChatComponent` (and settings component/SDK), connects in its session scope, observes network changes, and shuts everything down on logout. Do not create an SDK or connection in a screen or ViewModel.

## Chat route

Navigation Compose ships the route graph in `nav/AppNavHost.kt`. Chat is parameterized by nullable `sessionId`; the route is `chat` for a new conversation or `chat?sessionId=...` for an existing one. `ChatHost` resolves a fresh Koin ViewModel with `parametersOf(sessionId)` when the route entry changes.

```kotlin
class ChatViewModel(
    private val component: ChatComponent,
    sessionId: String?,
) : ViewModel() {
    init {
        component.switchConversation(sessionId)
        viewModelScope.launch {
            component.observeChat(cache.pending).collect { model ->
                _state.value = ChatUiState(
                    model = model,
                    pendingPermissionRequest = _state.value.pendingPermissionRequest,
                )
            }
        }
    }
}
```

`ChatViewModel` owns conversation UI state, optimistic outbox reconciliation, permission prompts, and command methods such as `send`, `retry`, `interrupt`, and `reconnect`. It takes `ChatComponent` plus `sessionId`; it does **not** close the connection in `onCleared`. Connection open/reconnect/pause/resume/close belongs to `UserSessionManager` and the shared SDK. A VM recreation during conversation navigation must not disconnect the authenticated session.

Other screen VMs are similarly thin: resolve usecases/components through Koin, launch work in `viewModelScope`, expose immutable `StateFlow`, and keep navigation decisions in the nav host.

## State and events

Keep renderable facts in immutable UI state. Use `collectAsStateWithLifecycle()`. For one-shot events that cannot be state, use a buffered `Channel`; do not use an unbuffered lifecycle-paused `SharedFlow` and assume delivery. Preserve user decisions (for example an open permission prompt) when replacing streamed chat state.

## Backend default

The debug build fallback URL is:

```text
wss://10.0.2.2:443/api/v1/ws
```

It is resolved from `local.properties` (`sentient.gatewayUrl`) and is not a reason to hard-code transport behavior elsewhere. Release has no baked default and uses backend setup.
