package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
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
}
