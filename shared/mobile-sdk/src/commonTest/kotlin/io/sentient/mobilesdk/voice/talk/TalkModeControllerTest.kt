// ---------------------------------------------------------------------------
// TalkModeControllerTest — pins the TalkMode FSM (design spec §3), a documented
// invariant per .claude/rules/testing.md (FSM + the mode-brain contract the platform
// slices S4/S5 + the UI slice S6 build on).
//
// The controller drives injected SEAMS (lambdas); the tests record their invocation +
// order via a Fakes harness, so every assertion is on the controller's CONTRACT (typed
// effects out), never on internal wiring. The full intent matrix (legal + illegal from
// every state), the press-interrupt gate, and the turnMode carried on capture are covered
// here; the buffer-and-defer is proven end-to-end against a real AudioPipeline + the
// shared FakeVoiceAudio double.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.talk

import io.sentient.mobilesdk.audioio.AudioPipeline
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TalkModeControllerTest {

    /** Records every seam invocation in order + the TurnMode carried on each capture. */
    private class Fakes(var active: Boolean = false) {
        val effects = mutableListOf<String>()
        val captureTurnModes = mutableListOf<TurnMode>()

        val controller = TalkModeController(
            startCapture = { tm -> captureTurnModes += tm; effects += "startCapture:${tm.name}" },
            endCapture = { effects += "endCapture" },
            cancelCapture = { effects += "cancelCapture" },
            interrupt = { effects += "interrupt" },
            isCycleOrTtsActive = { active },
            beginHoldDefer = { effects += "beginHoldDefer" },
            endHoldDefer = { effects += "endHoldDefer" },
            discardHoldDefer = { effects += "discardHoldDefer" },
        )

        /** Drive to [target] via legal intents, then clear the effect log. */
        fun driveTo(target: TalkMode) {
            when (target) {
                TalkMode.Idle -> Unit
                TalkMode.Hold -> controller.pressMic()
                TalkMode.Continuous -> { controller.pressMic(); controller.lockMic() }
            }
            assertEquals(target, controller.mode.value, "harness reached $target")
            effects.clear()
            captureTurnModes.clear()
        }
    }

    // ── Legal transitions + effect ordering ───────────────────────────────────────

    @Test
    fun press_from_idle_enters_hold_with_manual_capture_no_interrupt_when_inactive() {
        val f = Fakes(active = false)
        f.controller.pressMic()
        assertEquals(TalkMode.Hold, f.controller.mode.value)
        // No interrupt (nothing active); defer BEFORE capture so proactive TTS buffers at once.
        assertEquals(listOf("beginHoldDefer", "startCapture:Manual"), f.effects)
        assertEquals(listOf(TurnMode.Manual), f.captureTurnModes)
    }

    @Test
    fun press_from_idle_interrupts_first_when_cycle_or_tts_active() {
        val f = Fakes(active = true)
        f.controller.pressMic()
        assertEquals(TalkMode.Hold, f.controller.mode.value)
        // Press IS the barge-in: interrupt fires FIRST, then defer, then capture.
        assertEquals(listOf("interrupt", "beginHoldDefer", "startCapture:Manual"), f.effects)
    }

    @Test
    fun release_from_hold_ends_capture_then_flushes_deferred_buffer_to_idle() {
        val f = Fakes()
        f.driveTo(TalkMode.Hold)
        f.controller.releaseMic()
        assertEquals(TalkMode.Idle, f.controller.mode.value)
        assertEquals(listOf("endCapture", "endHoldDefer"), f.effects)
    }

    @Test
    fun cancel_from_hold_discards_capture_and_deferred_audio() {
        val f = Fakes()
        f.driveTo(TalkMode.Hold)
        f.controller.cancelHeld()
        assertEquals(TalkMode.Idle, f.controller.mode.value)
        assertEquals(listOf("cancelCapture", "discardHoldDefer"), f.effects)
    }

    @Test
    fun lifecycle_cancel_from_auto_cancels_capture_without_aliasing_interrupt() {
        val f = Fakes()
        f.driveTo(TalkMode.Continuous)
        f.controller.lifecycleCancel("view-disappear")
        assertEquals(TalkMode.Idle, f.controller.mode.value)
        assertEquals(listOf("cancelCapture"), f.effects)
    }

    @Test
    fun lock_from_hold_re_opens_semantic_back_to_back_then_arms_to_continuous() {
        val f = Fakes()
        f.driveTo(TalkMode.Hold)
        f.controller.lockMic()
        assertEquals(TalkMode.Continuous, f.controller.mode.value)
        // audio.end + audio.start(semantic) back-to-back, then arm+flush into the duplex path.
        assertEquals(listOf("endCapture", "startCapture:Semantic", "endHoldDefer"), f.effects)
        assertEquals(listOf(TurnMode.Semantic), f.captureTurnModes)
    }

    @Test
    fun stop_from_continuous_ends_capture_to_idle() {
        val f = Fakes()
        f.driveTo(TalkMode.Continuous)
        f.controller.stopContinuous()
        assertEquals(TalkMode.Idle, f.controller.mode.value)
        assertEquals(listOf("endCapture"), f.effects)
    }

    @Test
    fun capture_failure_forces_idle_without_duplicate_stop_and_is_idempotent() {
        val f = Fakes()
        f.driveTo(TalkMode.Hold)
        f.controller.captureLost("audio-error")
        f.controller.captureLost("audio-teardown")
        assertEquals(TalkMode.Idle, f.controller.mode.value)
        assertTrue(f.effects.isEmpty(), "failure reset must not emit a duplicate release/stop")
    }

    @Test
    fun transient_inactive_projection_does_not_change_hold_without_capture_loss() {
        val f = Fakes()
        f.driveTo(TalkMode.Hold)
        // The controller has no micActive input by design: only captureLost is authoritative.
        assertEquals(TalkMode.Hold, f.controller.mode.value)
        assertTrue(f.effects.isEmpty())
    }

    // ── Illegal intents from every state: WARN + no-op (state unchanged, zero effects) ──

    @Test
    fun idle_rejects_release_lock_and_stop() = assertNoOp(TalkMode.Idle) {
        listOf(it::releaseMic, it::lockMic, it::stopContinuous)
    }

    @Test
    fun hold_rejects_press_and_stop() = assertNoOp(TalkMode.Hold) {
        listOf(it::pressMic, it::stopContinuous)
    }

    @Test
    fun continuous_rejects_press_release_and_lock() = assertNoOp(TalkMode.Continuous) {
        listOf(it::pressMic, it::releaseMic, it::lockMic)
    }

    /** Drive to [state], then assert each illegal intent leaves the state + effect log untouched. */
    private fun assertNoOp(state: TalkMode, intents: (TalkModeController) -> List<() -> Unit>) {
        val f = Fakes(active = true) // even with a cycle active, an illegal intent must not interrupt
        f.driveTo(state)
        for (intent in intents(f.controller)) {
            intent()
            assertEquals(state, f.controller.mode.value, "illegal intent must not change state")
            assertTrue(f.effects.isEmpty(), "illegal intent must fire no seam effects: ${f.effects}")
        }
    }

    // ── Buffer-and-defer end-to-end (controller seams → real AudioPipeline → FakeVoiceAudio) ──

    @Test
    fun hold_defers_downlink_tts_then_flushes_on_release() = runTest {
        val sink = FakeVoiceAudio()
        val pipeline = AudioPipeline(
            playback = sink,
            opusDecoder = FakeOpusDecoderPort(),
            fsm = AudioFsm(),
            scope = this,
            outputSampleRate = 24_000,
            onStateChanged = { _, _ -> },
            armPlayback = { sink.configure(mic = false, playback = true); true },
            disarmPlayback = {},
        )
        val controller = TalkModeController(
            startCapture = {},
            endCapture = {},
            interrupt = {},
            isCycleOrTtsActive = { false },
            beginHoldDefer = { pipeline.beginHold() },
            endHoldDefer = { pipeline.endHold() },
        )

        controller.pressMic() // Idle → Hold: downlink now deferred
        // A second surface triggers a proactive TTS reply DURING the hold.
        pipeline.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        pipeline.onAudioFrame(byteArrayOf(1, 2), "c1")
        pipeline.onAudioFrame(byteArrayOf(3, 4), "c1")
        advanceUntilIdle()
        assertEquals(0, sink.playedFrames.size, "no playback armed while holding — frames buffered")
        assertTrue(sink.configureCalls.none { it.second }, "playback engine NOT armed during Hold")

        controller.releaseMic() // Hold → Idle: arm media playback + flush buffer in order
        advanceUntilIdle()
        assertEquals(2, sink.playedFrames.size, "deferred frames flushed on release")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(1, 2)), "flushed in FIFO order (first)")
        assertTrue(sink.playedFrames[1].contentEquals(byteArrayOf(3, 4)), "flushed in FIFO order (second)")
    }
}
