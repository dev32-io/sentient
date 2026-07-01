package io.sentient.mobilesdk.voice

import io.sentient.mobilesdk.sdk.AudioPipelineConfig
import io.sentient.mobilesdk.sdk.SdkVoice
import io.sentient.mobilesdk.voice.io.MicSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

// A mic whose start() SUSPENDS on the virtual clock — models the real
// IosMicSource/AndroidMicSource start() (a `withContext` that genuinely suspends).
// frames is an open stream that never emits, so the pipeline never touches the (lazy)
// encoder → no native libopus on the JVM host. state flips Live only AFTER the delay
// elapses, so a Stop enqueued during the delay window is in-flight behind an
// unfinished Start — exactly the toggle-race precondition.
private class SuspendingStartMic : MicSource {
    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    override val frames: Flow<ShortArray> = MutableSharedFlow()
    override val state: StateFlow<MicState> = _state

    override suspend fun start() {
        delay(START_SUSPEND_MS) // SUSPEND — Start is in-flight while Stop is enqueued.
        _state.value = MicState.Live
    }

    override suspend fun stop() {
        _state.value = MicState.Idle
    }

    companion object {
        const val START_SUSPEND_MS = 50L
    }
}

/**
 * Serialization contract (fix pass, review Minor #3): a start→stop toggle where
 * mic.start() SUSPENDS must still leave the mic STOPPED, never Live.
 *
 * Under the old two-independent-launch design the Stop coroutine ran while the Start
 * coroutine was suspended inside mic.start() with the collect `job` still null — so
 * cancelAndJoin no-op'd, tore the mic down, then the resumed Start re-installed the
 * engine and left the mic LIVE after the Stop. The ordered command consumer makes a
 * submitted Start fully complete (engine Live + collect job assigned) BEFORE the
 * queued Stop runs — so the final state is Idle and the control callbacks fire
 * start-before-stop in the SAME serialized lane.
 */
class SdkVoiceSerializationTest {

    @Test
    fun start_then_stop_leaves_mic_idle_even_when_start_suspends() = runTest {
        val order = mutableListOf<String>()
        val mic = SuspendingStartMic()
        // Foreground detached scope (NOT backgroundScope): advanceUntilIdle only
        // advances virtual time for foreground delays, and mic.start() suspends on
        // one. Detached Job() keeps runTest from flagging the infinite consumer as
        // leaked; we cancel it explicitly at the end.
        val voiceScope = CoroutineScope(coroutineContext + Job())
        val voice = SdkVoice(
            mic = mic,
            audioConfig = AudioPipelineConfig(),
            audioInput = { error("no frames flow → audioInput must never be deref'd") },
            onUplinkStart = { order.add(START) },
            onUplinkStop = { order.add(STOP) },
            scope = voiceScope,
            uplinkDispatcher = UnconfinedTestDispatcher(testScheduler),
        )

        // Submit BOTH toggles; then let the consumer begin. handle(Start) fires
        // onUplinkStart, then SUSPENDS inside pipeline.start() → mic.start()'s delay.
        voice.requestStart()
        voice.requestStop()
        testScheduler.runCurrent()

        // Start is genuinely in-flight (suspended before Live); Stop is queued BEHIND
        // it on the single consumer, not racing it. The old design tore down here.
        assertEquals(listOf(START), order, "Start must be in-flight, Stop still queued")
        assertEquals(MicState.Idle, mic.state.value, "mic not Live yet — start suspended")

        // Advance past the delay: Start completes (Live + job assigned), THEN Stop runs.
        testScheduler.advanceUntilIdle()

        assertEquals(MicState.Idle, mic.state.value, "mic STOPPED after start→stop, never left Live")
        assertEquals(listOf(START, STOP), order, "control frames fired start-before-stop, serialized")

        voiceScope.cancel()
    }

    private companion object {
        const val START = "start"
        const val STOP = "stop"
    }
}
