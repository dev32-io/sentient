# Coroutines / Flow Public Surface — Details

The SDK's public API uses coroutines primitives that SKIE can cleanly bridge to Swift async/await and AsyncSequence.

## Examples

**Single StateFlow state surface:**
```kotlin
// commonMain — SdkState is the only observable
sealed interface SdkState {
    object Disconnected : SdkState
    object Connecting   : SdkState
    data class Ready(val sessionId: String) : SdkState
    data class Error(val cause: String)     : SdkState
}

class SentientMobileSDK(/* deps */) {
    private val _state = MutableStateFlow<SdkState>(SdkState.Disconnected)
    val state: StateFlow<SdkState> = _state.asStateFlow()

    suspend fun connect(url: String, token: String) { /* … */ }
    suspend fun disconnect() { /* … */ }
    suspend fun sendText(text: String) { /* … */ }
}
```

**SKIE maps StateFlow to Swift AsyncSequence automatically:**
```swift
// Swift consumer — no callback registration needed
for await state in sdk.state {
    switch state {
    case .ready(let s): showReady(session: s.sessionId)
    case .error(let e): showError(e.cause)
    default: break
    }
}
```

**Scope tied to connect/disconnect — no GlobalScope:**
```kotlin
private var sdkScope: CoroutineScope? = null

suspend fun connect(url: String, token: String) {
    sdkScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    sdkScope!!.launch { runReconnectLoop(url, token) }
}

suspend fun disconnect() {
    sdkScope?.cancel()
    sdkScope = null
    _state.value = SdkState.Disconnected
}
```

## Gotchas

- Exposing a `Flow<T>` of a generic sealed type sometimes needs a SKIE `@HiddenFromObjC` wrapper — see SKIE sealed-class/flow docs.
- `Channel` exposed as a public property becomes an opaque `SendChannel`/`ReceiveChannel` in Swift with no SKIE sugar — always wrap in a Flow or suspend fun before the public boundary.
- `Dispatchers.Main` is not available in commonMain without the `kotlinx-coroutines-core` main-dispatcher artifact for each platform; use `Dispatchers.Default` in the SDK core and let the UI layer switch to Main.
- `StateFlow.value` reads are thread-safe but `collect` on iOS requires the coroutine to run on a single thread (use `Dispatchers.Main` or a confined dispatcher when bridging to Swift UI).
