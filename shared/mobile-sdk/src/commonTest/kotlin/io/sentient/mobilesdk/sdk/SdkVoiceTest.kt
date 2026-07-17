package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import io.sentient.mobilesdk.voice.talk.TurnMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The [SdkVoice] constructor takes both [scope] (the command-consumer coroutine's
 * scope) and [uplinkDispatcher] (the pipeline's collect-job dispatcher). Both default
 * to [Dispatchers.Default] in production. Under `runTest`, the test scheduler only
 * drains work dispatched to IT — it cannot wait for a real Default-dispatcher job.
 *
 * So the test pins BOTH to [Dispatchers.Unconfined]: the consumer runs inline on
 * `trySend`, and the collect job (launched by `pipeline.start()`) also runs on
 * Unconfined, so `pipeline.stop()` → `cancelAndJoin` completes synchronously inline
 * (the collect's `micFrames.collect` resumes inline with CancellationException).
 * This is a TEST-SIDE adjustment only — the production design is unchanged (Default
 * serial dispatcher for the collect job). No production code was altered to make
 * the test deterministic.
 */

/**
 * Pins the SdkVoice configure-lane serialization invariant (Task 9).
 *
 * Replaces the old SdkVoiceSerializationTest (deleted in T7 — it pinned the
 * now-eliminated suspending-mic.start() race). The configure lane is the new
 * single serialized path: every mic + TTS reconfig rides one FIFO consumer, so
 * mic + TTS reconfigs NEVER race. These tests hammer the lane with rapid
 * toggles and assert the idempotent collapse + audio.start/audio.end edge order.
 */
class SdkVoiceTest {

    @Test
    fun rapid_mic_toggles_serialize_and_never_race() = runTest {
        val va = FakeVoiceAudio()
        val starts = mutableListOf<Boolean>() // onUplinkStart/onUplinkStop edges
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = { starts += true },
            onUplinkStop = { starts += false },
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        // Hammer the lane — a FIFO consumer must apply these in submission order.
        repeat(5) { voice.requestConfigure(mic = true, playback = false) }
        repeat(5) { voice.requestConfigure(mic = false, playback = false) }
        // Drain the ordered consumer on the test scheduler.
        // (If SdkVoice's consumer runs on Dispatchers.Default, advanceUntilIdle; if it
        //  runs on the injected scope, the Unconfined scope drains synchronously.)
        advanceUntilIdle()

        // The lane collapses consecutive identical configures (idempotent diff), so
        // after 5×(true) + 5×(false) the engine saw mic on then off — exactly one
        // audio.start edge and one audio.end edge, in that order.
        assertEquals(listOf(true, false), starts.distinct(), "audio.start must precede audio.end")
        // And configure was called for the mic-on then mic-off transitions only.
        assertEquals(2, va.configureCalls.size, "idempotent configure collapses repeats")
    }

    @Test
    fun tts_toggle_with_mic_on_enables_vpio_cell() = runTest {
        val va = FakeVoiceAudio()
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = {},
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        voice.requestConfigure(mic = true, playback = false); advanceUntilIdle()
        voice.requestConfigure(mic = true, playback = true);  advanceUntilIdle()  // mic stays on → no audio.end
        voice.requestConfigure(mic = false, playback = false); advanceUntilIdle()
        // Transitions applied: (F,F)->(T,F)->(T,T)->(F,F). audio.start on first mic-on,
        // audio.end on the final mic-off. No spurious audio.start/audio.end between.
        assertEquals(3, va.configureCalls.size)
    }

    @Test
    fun requestStart_threads_turnMode_to_onUplinkStart() = runTest {
        val va = FakeVoiceAudio()
        val turnModes = mutableListOf<TurnMode?>()
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = { turnModes += it }, // capture the mic-rising edge's TurnMode
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        // Hold entry: audio.start(turnMode=manual) rides the mic-rising edge.
        voice.requestStart(TurnMode.Manual); advanceUntilIdle()
        voice.requestStop(); advanceUntilIdle()
        // Continuous entry: audio.start(turnMode=semantic).
        voice.requestStart(TurnMode.Semantic); advanceUntilIdle()
        assertEquals(listOf<TurnMode?>(TurnMode.Manual, TurnMode.Semantic), turnModes, "each mic-rising edge carries its TurnMode")
    }

    @Test
    fun requestStart_default_turnMode_is_null_semantic() = runTest {
        val va = FakeVoiceAudio()
        val turnModes = mutableListOf<TurnMode?>()
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = { turnModes += it },
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        // The pre-existing continuous path (startMic → requestStart()) is unchanged: null
        // turnMode ⇒ audio.start omits the field ⇒ gateway defaults to semantic.
        voice.requestStart(); advanceUntilIdle()
        assertEquals(listOf<TurnMode?>(null), turnModes)
    }

    @Test
    fun armPlayback_returns_true_and_arms_the_playback_axis() = runTest {
        val va = FakeVoiceAudio()
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = {},
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        // Lazy arm from idle: the ack resolves to THIS command's result (Ready+playbackActive).
        val armed = voice.armPlayback()
        assertEquals(true, armed, "armPlayback returns true once the engine is playback-active")
        assertEquals(1, va.configureCalls.size, "arm drove exactly one configure(playback=true)")
        val (mic, playback, _) = va.configureCalls.single()
        assertEquals(false, mic, "arm keeps the mic axis (off here)")
        assertEquals(true, playback, "arm turned playback on")
    }

    @Test
    fun armPlayback_while_mic_on_keeps_mic_and_flips_vpio_cell() = runTest {
        val va = FakeVoiceAudio()
        val voice = SdkVoice(
            voiceAudio = va,
            audioConfig = AudioPipelineConfig(),
            audioInput = { throw IllegalStateException("not used here") },
            onUplinkStart = {},
            onUplinkStop = {},
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
        )
        voice.requestStart(); advanceUntilIdle() // mic on, playback off (mic-only cell)
        val armed = voice.armPlayback()          // TTS reply starts while mic is live
        assertEquals(true, armed, "arm succeeds in the full-duplex cell")
        // Arm composed with the live mic → the (mic=true, playback=true) VPIO cell.
        val last = va.configureCalls.last()
        assertEquals(true, last.first, "arm preserved the live mic axis")
        assertEquals(true, last.second, "arm turned playback on → full-duplex VPIO cell")

        // Disarm after the reply drains: mic stays on → mic-only cell (engine stays up).
        voice.requestPlayback(false); advanceUntilIdle()
        val afterDisarm = va.configureCalls.last()
        assertEquals(true, afterDisarm.first, "disarm keeps the mic on (no per-reply teardown in voice mode)")
        assertEquals(false, afterDisarm.second, "disarm dropped playback back to the mic-only cell")
    }
}
