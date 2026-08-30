# Coroutines / Flow Public Surface — Details

This file expands `.claude/rules/mobile-shared.md`. The KMP SDK exposes latest-value state as `StateFlow`, ordered one-shot notifications as a buffered `SharedFlow<SdkEvent>`, and asynchronous commands as `suspend` functions where a result is awaited.

## Public observable surfaces

```kotlin
class SentientSdk(/* ... */) {
    val connection: StateFlow<ConnectionState>
    val timeline: StateFlow<List<ChatMessage>>
    val tasks: StateFlow<List<TaskListItem>>
    val permissions: StateFlow<List<PermissionPrompt>>
    val delegations: StateFlow<List<DelegationSnapshotItem>>
    val currentSessionId: StateFlow<String?>
    val events: SharedFlow<SdkEvent>

    suspend fun connect()
    fun disconnect(clearSession: Boolean = true)
    fun sendText(text: String, pendingId: String? = null)
    fun interrupt()
    fun ensureConnected()
}
```

Conflation is correct for complete state snapshots (`connection`, committed `timeline`, complete task/prompt/delegation lists). It is not correct for streamed text chunks or one-shot decisions.

## SdkEvent

Current variants are flat SKIE-friendly sealed subclasses:

```kotlin
sealed class SdkEvent {
    data class MessageStarted(val turnId: String, val replyId: String?) : SdkEvent()
    data class MessageDelta(val turnId: String, val chunk: String, val replyId: String?) : SdkEvent()
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class TurnDone(val turnId: String) : SdkEvent()
    data class TurnAborted(val turnId: String, val cutoff: String) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()
    data class PermissionRequested(val prompt: PermissionPrompt) : SdkEvent()
    data class PermissionResolved(val requestId: String, val outcome: String) : SdkEvent()
    data class DelegationProgressed(val task: DelegationSnapshotItem) : SdkEvent()
    data object ReopenFailed : SdkEvent()
}
```

Tool-strip updates are not `SdkEvent`: `tasklist.state` is a complete server-authoritative list exposed through `tasks`.

`events` uses `MutableSharedFlow` with `replay = 0`, bounded extra capacity, and `BufferOverflow.SUSPEND`. `tryEmit` falls back to a scoped suspending `emit`, so chunks are not intentionally dropped when the buffer fills.

## turn.* mapping

`InFlightMessageConnector` maps exact gateway frames:

- `turn.started` → `MessageStarted(turnId)` and an empty placeholder;
- each `turn.text.delta` → one `MessageDelta(turnId, chunk, replyId)`;
- `turn.completed` → `MessageCommitted` clear signals for that turn's open reply bubbles;
- `turn.aborted` → drop those buffers; `TurnErrorConnector` emits `TurnAborted`.

`replyId` identifies a bubble within a turn. The first stamped delta adopts the placeholder opened by `turn.started`; later reply ids may open another bubble after a mid-turn steer.

## Consumption boundary

Shared mobile-data consumes SDK flows. `SdkConversationRepository` is a stateless passthrough, and `ObserveChatUseCase` folds `SdkEvent` into the chat projection. Native VMs collect the usecase's `Flow<ChatModel>` and complete state flows; they should not rebuild the event reducer.

SKIE exposes these Kotlin flows as Swift async sequences:

```swift
for await model in component.observeChat.invoke(pending: pendingFlow) {
    apply(model)
}
```

Use `onEnum(of:)` when Swift must exhaustively inspect a sealed value. Do not add `Channel`, `Deferred`, or raw `Job` to the public API, and do not introduce Combine merely to consume a KMP flow.

## Scope ownership

Android `UserSessionManager` and iOS `IosUserSession` construct the SDK with an authenticated session scope. Disconnect tears down transport loops; authenticated-boundary close cancels the owning scope. Route-scoped chat VMs cancel only their collectors and keep the shared connection alive.
