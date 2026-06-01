# commonMain Purity — Details

commonMain code must compile for every target (JVM/Android, iOS/Native) without any platform-specific import.

## Examples

**Inject Clock instead of calling platform time directly:**
```kotlin
// commonMain — correct
interface Clock { fun nowMs(): Long }

class IdleDetector(private val clock: Clock) {
    fun isIdle(lastActiveMs: Long, thresholdMs: Long): Boolean =
        clock.nowMs() - lastActiveMs > thresholdMs
}

// androidMain actual
class AndroidClock : Clock {
    override fun nowMs() = System.currentTimeMillis()
}

// commonTest — deterministic
class FakeClock(var time: Long = 0L) : Clock {
    override fun nowMs() = time
}
```

**Inject WebSocket engine via interface:**
```kotlin
// commonMain — never import ktor or okhttp here
interface WsEngine {
    suspend fun connect(url: String, token: String): WsSession
}

interface WsSession {
    val incoming: Flow<WsFrame>
    suspend fun send(frame: WsFrame)
    suspend fun close()
}
```

**Gate logic in commonTest (no platform):**
```kotlin
@Test fun `opens on voice onset, closes after hold`() {
    val gate = SpeechGate(holdMs = 300, fakeClock)
    gate.onVoiceOnset()
    assertTrue(gate.isOpen)
    fakeClock.advance(301); gate.tick()
    assertFalse(gate.isOpen)
}
```

## Gotchas

- `kotlinx.datetime.Clock.System.now()` is fine in commonMain, but `System.currentTimeMillis()` is JVM-only and breaks the iOS target — inject a Clock.
- `kotlin.random.Random` is fine; `java.util.Random` is not.
- `println()` compiles everywhere but produces no output on iOS release — use the injected LogSink instead.
