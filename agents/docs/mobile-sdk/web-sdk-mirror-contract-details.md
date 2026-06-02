# web-sdk Mirror Contract — Details

mobile-sdk is the KMP twin of web-sdk: same gateway wire protocol, same gate semantics, same state names — different runtime.

## Examples

**Mirror the exact wire frame types from web-sdk:**
```kotlin
// commonMain — match web-sdk's connector-types.ts message shapes exactly
sealed interface GatewayFrame {
    data class Auth(val token: String)                      : GatewayFrame
    data class SessionConfigure(val capabilities: List<String>) : GatewayFrame
    data class SessionReady(
        val sessionId: String,
        val audioEncoding: String,
        val inputSampleRate: Int,
        val outputSampleRate: Int,
    ) : GatewayFrame
    data class ConversationAppend(val entry: ConversationEntry) : GatewayFrame
    object Ping : GatewayFrame
    object Pong : GatewayFrame
    object Interrupt : GatewayFrame
}
```

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
// commonMain — mirror web-sdk/src/speech-gate.ts state names
enum class SpeechGateState { Closed, Open, HoldOpen, Cooldown }
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

## EchoGate clock deviation (deliberate)

The TS `createEchoGate` uses an injected `EchoGateScheduler` (schedule/cancel callbacks) to fire the tail-hold timer. The KMP `EchoGate` replaces this with an injected monotonic timestamp: `onPlaybackDrain(cycleId, nowMs)` records `tailExpiresAtMs = nowMs + tailHoldMs`, and `state(nowMs)` / `acceptFrame(pcm, nowMs)` lazily check expiry against the passed `nowMs`. State-machine transitions, threshold semantics, and boundary conditions are identical to the TS implementation. The deviation eliminates scheduler wiring from commonMain (no platform clock dependency) and makes all tests deterministic with no fake-timer machinery.
