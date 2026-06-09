# Coroutines / Flow Public Surface — Details

The SDK's public API uses coroutines primitives that SKIE can cleanly bridge to Swift async/await and AsyncSequence. The surface is SPLIT across three flows so streaming is lossless.

## The three surfaces

```kotlin
// shared/mobile-sdk/.../sdk/SentientSdk.kt
class SentientSdk(/* config, bundle, scope … */) {
    // continuous state — conflation is fine, latest value wins
    val connection: StateFlow<ConnectionState>     // transport status + voice/audio axis
    val timeline:   StateFlow<List<ChatMessage>>   // committed message history

    // one-shot, no-loss notifications — a SharedFlow, NOT a StateFlow
    val events: SharedFlow<SdkEvent>

    suspend fun connect()                          // → READY; re-entrancy-guarded
    fun disconnect(clearSession: Boolean = true)
    fun sendText(text: String, pendingId: String? = null)
    fun interrupt(); fun startMic(); fun stopMic()
    suspend fun listSessions(limit: Int, offset: Int): SessionsListPage
    suspend fun switchSession(id: String); suspend fun newChat()
    fun forceReconnect()                           // presence/foreground-driven retry
}
```

## The no-loss events SharedFlow (the streaming fix)

```kotlin
private val _events = MutableSharedFlow<SdkEvent>(
    replay = 0,
    extraBufferCapacity = EVENTS_BUFFER_CAPACITY,   // 256
    onBufferOverflow = BufferOverflow.SUSPEND,       // back-pressure, never drop
)
val events: SharedFlow<SdkEvent> = _events.asSharedFlow()

private fun emitEvent(event: SdkEvent) {
    if (!_events.tryEmit(event)) scope.launch { _events.emit(event) }  // suspend if buffer full
}
```

`SdkEvent` is a flat sealed class — every variant SKIE-bridges to a Swift enum case:

```kotlin
sealed class SdkEvent {
    data class MessageStarted(val cycleId: String) : SdkEvent()
    data class MessageDelta(val cycleId: String, val chunk: String) : SdkEvent()   // streamed token
    data class MessageCommitted(val message: ChatMessage) : SdkEvent()             // clear-live signal
    data class TaskUpserted(val task: TaskSnapshotItem) : SdkEvent()
    data class TranscriptUpdated(val text: String) : SdkEvent()
    data class CycleDone(val cycleId: String) : SdkEvent()
    data class CycleAborted(val cycleId: String, val kind: String?) : SdkEvent()
    data class SessionSwitched(val sessionId: String) : SdkEvent()
    data class ProtocolError(val error: SentientError) : SdkEvent()                // errors as values
}
```

## SKIE consumption in Swift

```swift
// connection / timeline are StateFlows → AsyncSequence; events is a SharedFlow → AsyncSequence
for await c in sdk.connection { /* render status */ }
for await e in sdk.events {
    onEnum(of: e) { ev in
        switch ev {
        case .messageDelta(let d): append(d.chunk)
        case .protocolError(let p): show(p.error)
        default: break
        }
    }
}
```

The app does NOT collect `events` directly — `ChatRepository` (in `shared/mobile-data`) owns the collector and folds events into `chatStream`. See `mobile-data/repositories`.

## Scope tied to connect/disconnect — no GlobalScope

The SDK is handed a `CoroutineScope` at construction (the session scope). `disconnect()` tears down loops; `close()` on the owning `MobileSession` cancels the scope. No coroutine outlives the session.

## Gotchas

- **Streaming deltas MUST be on the SharedFlow.** A `StateFlow` conflates intermediate emissions, so fast token deltas collapse to the latest — the message appears to "pop in at once". The no-loss SharedFlow + a pure reducer downstream is the fix.
- Exposing a `Flow<T>` of a generic sealed type sometimes needs a SKIE wrapper — see SKIE sealed-class/flow docs.
- `Channel` exposed as a public property becomes an opaque `SendChannel`/`ReceiveChannel` in Swift with no SKIE sugar — always wrap in a Flow or suspend fun before the public boundary.
- `Dispatchers.Main` is not in commonMain without the per-platform main-dispatcher artifact; use `Dispatchers.Default` in core and let the UI switch to Main.
- `StateFlow.value` reads are thread-safe but `collect` on iOS requires a confined dispatcher when bridging to Swift UI.
