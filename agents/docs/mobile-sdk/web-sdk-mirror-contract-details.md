# web-sdk Mirror Contract — Details

mobile-sdk is the KMP twin of web-sdk: same gateway wire protocol, same gate semantics, same state names — different runtime.

## Examples

**Mirror the exact wire frame types from web-sdk — split by direction:**
```kotlin
// commonMain — protocol/ClientMessage.kt (outbound) — real variant names
sealed class ClientMessage {
    data class Auth(val token: String) : ClientMessage()
    data class SessionConfigure(/* capabilities, prefs */) : ClientMessage()
    data class TextInput(val text: String, val pendingId: String?) : ClientMessage()  // pendingId round-trip
    data object AudioStart : ClientMessage(); data object AudioEnd : ClientMessage()
    data class ToolConfirm(/* … */) : ClientMessage()
    data class SessionsList(/* limit, offset */) : ClientMessage()
    data class SessionNew(/* … */) : ClientMessage(); data class SessionSwitch(/* id */) : ClientMessage()
    data object Ping : ClientMessage(); data object Interrupt : ClientMessage()
}

// protocol/ServerMessage.kt (inbound) — real variant names
sealed class ServerMessage {
    data class AuthOk(/* … */) : ServerMessage(); data class AuthError(/* … */) : ServerMessage()
    data class SessionReady(val sessionId: String, /* sample rates, encoding */) : ServerMessage()
    data class MessageDelta(val cycleId: String, val chunk: String) : ServerMessage()  // streamed token
    data class MessageDone(/* … */) : ServerMessage()
    data class CycleStarted(/* … */) : ServerMessage(); data class CycleCompleted(/* … */) : ServerMessage()
    data class CycleAborted(/* kind */) : ServerMessage(); data class TaskUpdate(/* … */) : ServerMessage()
    data class ConversationSnapshot(/* … */) : ServerMessage(); data class ConversationEntry(/* … */) : ServerMessage()
    data class Error(/* … */) : ServerMessage(); data object Pong : ServerMessage(); data object Unknown : ServerMessage()
}
```
The JSON `type` strings (`auth`, `session.ready`, `message.delta`, `cycle.*`, …) are the actual wire contract; the Kotlin variant names above are the in-memory mirror. Cross-check `shared/web-sdk/src/` and `shared/protocol/` before changing either side.

**Binary audio frames — raw PCM, not base64 JSON:**
```kotlin
// correct — mirrors web-sdk's sendBinary() path
interface WsSession {
    suspend fun sendBinary(pcm16Le: ByteArray)   // raw binary frame
    suspend fun sendJson(frame: GatewayFrame)    // JSON control frame
    val incomingBinary: Flow<ByteArray>          // raw PCM from gateway
    val incomingJson: Flow<GatewayFrame>
}

// WRONG — do NOT do this
data class AudioJsonEnvelope(val type: String, val data: String /* base64 */)
```

**Port SpeechGate transition table from web-sdk with identical states:**
```kotlin
// commonMain — mirror web-sdk/src/speech-gate.ts state names (two states, not four)
enum class SpeechGateState { CLOSED, OPEN }   // matches web-sdk speech-gate.ts "closed" | "open"
```

**Logger tag mirrors web-sdk's createLogger shape:**
```kotlin
// commonMain
val log = Logger(tags = listOf("sentient", "mobile-sdk", "reconnect"))
log.debug("attempting reconnect", mapOf("attempt" to attempt, "delayMs" to delay))
```

## Gotchas

- The gateway sends raw PCM16 LE binary frames separate from JSON control frames — mirror web-sdk's binary handling, don't base64 into JSON.
- `session.ready` carries `inputSampleRate` and `outputSampleRate` as integers — do not rename these fields or the JSON deserializer silently reads 0 (Kotlin data class field name must match JSON key exactly, or add `@SerialName`).
- When web-sdk adds a new message type (e.g., `cycle.done`), mobile-sdk must add it in the same PR — divergence causes silent drop of gateway frames.
- SpeechGate and EchoGate unit tests in commonTest must assert the same transitions as the web-sdk vitest suite; if they diverge, it is a bug in the port, not a platform difference.
- "Same status states" means the TRANSPORT axis: `ConnectionState` projects status + voice/audio. Cognition/cycle progress is NOT on the connection surface — it is surfaced as `SdkEvent.CycleDone`/`CycleAborted` (folded from `cycle.*` server frames). Mirror that split; do not stuff cycle state onto `ConnectionState`.

## EchoGate clock deviation (deliberate)

The TS `createEchoGate` uses an injected `EchoGateScheduler` (schedule/cancel callbacks) to fire the tail-hold timer. The KMP `EchoGate` replaces this with an injected monotonic timestamp: `onPlaybackDrain(cycleId, nowMs)` records `tailExpiresAtMs = nowMs + tailHoldMs`, and `state(nowMs)` / `acceptFrame(pcm, nowMs)` lazily check expiry against the passed `nowMs`. State-machine transitions, threshold semantics, and boundary conditions are identical to the TS implementation. The deviation eliminates scheduler wiring from commonMain (no platform clock dependency) and makes all tests deterministic with no fake-timer machinery.
