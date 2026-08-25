package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import io.sentient.mobilesdk.voice.io.VoiceAudioPath
import io.sentient.mobilesdk.voice.talk.TurnMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

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
    fun requestStart_default_turnMode_is_explicit_semantic() = runTest {
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
        // New capture-aware clients make semantic mode explicit on every start.
        voice.requestStart(); advanceUntilIdle()
        assertEquals(listOf<TurnMode?>(TurnMode.Semantic), turnModes)
    }

    @Test
    fun hold_to_auto_serializes_matching_end_before_fresh_semantic_start_and_first_terminal_wins() = runTest {
        val sent = mutableListOf<ClientMessage>()
        val connector = UserAudioInputConnector(send = { sent += it }, sendBinary = {})
        val ids = listOf("manual-id", "auto-id").iterator()
        val voice = SdkVoice(
            voiceAudio = FakeVoiceAudio(),
            audioConfig = AudioPipelineConfig(),
            audioInput = { connector },
            onUplinkStart = { capture, mode -> connector.startStreaming(capture, mode) },
            onUplinkBeginTerminal = { connector.beginTerminal(it) },
            onUplinkTerminal = { capture, terminal -> connector.completeTerminal(capture, terminal) },
            scope = CoroutineScope(Dispatchers.Unconfined),
            uplinkDispatcher = Dispatchers.Unconfined,
            createCaptureId = { ids.next() },
        )
        voice.requestStart(TurnMode.Manual)
        voice.requestStop()
        voice.requestCancel() // duplicate terminal cannot replace the accepted commit
        voice.requestStart(TurnMode.Semantic)
        advanceUntilIdle()
        assertEquals(
            listOf(
                ClientMessage.AudioStart("manual-id", "manual"),
                ClientMessage.AudioEnd("manual-id"),
                ClientMessage.AudioStart("auto-id", "semantic"),
            ),
            sent,
        )
    }

    @Test
    fun teardown_awaits_cancel_terminal_and_leaves_no_active_capture_or_late_frames() = runTest {
        val controls = mutableListOf<ClientMessage>()
        val frames = mutableListOf<ByteArray>()
        val connector = UserAudioInputConnector(send = { controls += it }, sendBinary = { frames += it })
        val voice = SdkVoice(
            voiceAudio = null,
            audioConfig = AudioPipelineConfig(),
            audioInput = { connector },
            onUplinkStart = { capture, mode -> connector.startStreaming(capture, mode) },
            onUplinkBeginTerminal = { connector.beginTerminal(it) },
            onUplinkTerminal = { capture, terminal -> connector.completeTerminal(capture, terminal) },
            scope = backgroundScope,
            uplinkDispatcher = StandardTestDispatcher(testScheduler),
            createCaptureId = { "teardown-id" },
        )

        voice.requestStart(TurnMode.Manual)
        val teardown = backgroundScope.launch { voice.cancelCaptureAndAwait() }
        advanceUntilIdle()
        teardown.join()
        connector.sendAudioFrame(byteArrayOf(1, 2, 3))
        voice.requestStart(TurnMode.Semantic)
        advanceUntilIdle()

        assertEquals(
            listOf(ClientMessage.AudioStart("teardown-id", "manual"), ClientMessage.AudioCancel("teardown-id")),
            controls,
        )
        assertFalse(connector.hasActiveCapture, "awaited teardown must not retain a streaming/terminating capture")
        assertEquals(emptyList(), frames, "no binary frame may be accepted after the terminal control")
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

    // ── VoiceAudioPath threading (S3b) ──────────────────────────────────────────

    private fun sdkVoice(va: FakeVoiceAudio) = SdkVoice(
        voiceAudio = va,
        audioConfig = AudioPipelineConfig(),
        audioInput = { throw IllegalStateException("not used here") },
        onUplinkStart = {},
        onUplinkStop = {},
        scope = CoroutineScope(Dispatchers.Unconfined),
        uplinkDispatcher = Dispatchers.Unconfined,
    )

    @Test
    fun mic_rising_configure_derives_path_from_turnMode() = runTest {
        // Hold entry: TurnMode.Manual on the mic-rising edge → VoiceAudioPath.Manual.
        val manualVa = FakeVoiceAudio()
        val manualVoice = sdkVoice(manualVa)
        manualVoice.requestStart(TurnMode.Manual)
        advanceUntilIdle()
        assertEquals(listOf(VoiceAudioPath.Manual), manualVa.configuredPaths, "Manual turnMode on the mic-rising edge derives VoiceAudioPath.Manual")

        // Continuous entry: TurnMode.Semantic on the mic-rising edge → VoiceAudioPath.Duplex.
        val semanticVa = FakeVoiceAudio()
        val semanticVoice = sdkVoice(semanticVa)
        semanticVoice.requestStart(TurnMode.Semantic)
        advanceUntilIdle()
        assertEquals(listOf(VoiceAudioPath.Duplex), semanticVa.configuredPaths, "non-Manual turnMode on the mic-rising edge derives VoiceAudioPath.Duplex")
    }

    @Test
    fun continuous_configure_carries_duplex_path() = runTest {
        val va = FakeVoiceAudio()
        val voice = sdkVoice(va)
        // Realistic continuous-mode sequence: mic on (no turnMode declared) → TTS toggle
        // mid-mic (VPIO cell) → mic off. No Manual turnMode is ever supplied, so every
        // transition — rising, same-state-toggle, and falling — carries VoiceAudioPath.Duplex.
        voice.requestConfigure(mic = true, playback = false); advanceUntilIdle()
        voice.requestConfigure(mic = true, playback = true); advanceUntilIdle()
        voice.requestConfigure(mic = false, playback = false); advanceUntilIdle()
        assertEquals(List(3) { VoiceAudioPath.Duplex }, va.configuredPaths, "continuous mode never derives Manual; every cell in the sequence carries Duplex")
    }

    @Test
    fun hold_release_arm_carries_manual_path() = runTest {
        val va = FakeVoiceAudio()
        val voice = sdkVoice(va)
        // pressMic(): Hold entry establishes the Manual cell.
        voice.requestStart(TurnMode.Manual); advanceUntilIdle()
        // releaseMic(): endCapture() drops the mic axis (mic-falling, no turnMode) — the
        // tracked path must NOT reset to Duplex here.
        voice.requestStop(); advanceUntilIdle()
        // endHoldDefer(): the release arm (playback-only axis, no turnMode) must land on the
        // Manual cell the Hold entry established — the future MediaPlayback engine, not the
        // duplex engine.
        val armed = voice.armPlayback()
        assertEquals(true, armed)
        assertEquals(VoiceAudioPath.Manual, va.configuredPaths.last(), "Hold-release arm carries the tracked Manual path")
        val lastCall = va.configureCalls.last()
        assertEquals(false, lastCall.first, "release arm is playback-only (mic already fell)")
        assertEquals(true, lastCall.second, "release arm turns playback on")
    }

    @Test
    fun same_cell_different_path_does_not_collapse() = runTest {
        val va = FakeVoiceAudio()
        val voice = sdkVoice(va)
        // Establish (mic=true, playback=false, path=Manual) via a real Hold entry.
        voice.requestStart(TurnMode.Manual); advanceUntilIdle()
        assertEquals(listOf(VoiceAudioPath.Manual), va.configuredPaths)

        // A same-cell path-flip (mic/playback unchanged, path differs) is unreachable via the
        // public requestConfigure/requestStart/requestPlayback/armPlayback surface today
        // (derivePath only diverges from currentPath on a mic-rising edge, which always
        // changes c.mic too) — requestConfigureWithPath is a TEST-ONLY seam that bypasses
        // derivePath so this guard is pinned even though no caller can trigger it yet.
        voice.requestConfigureWithPath(mic = true, playback = false, path = VoiceAudioPath.Duplex)
        advanceUntilIdle()

        assertEquals(
            listOf(VoiceAudioPath.Manual, VoiceAudioPath.Duplex),
            va.configuredPaths,
            "a same-cell path-flip drives a REAL voiceAudio.configure (not swallowed by the idempotent collapse) and carries the new path",
        )
        assertEquals(
            listOf(true to false, true to false),
            va.configureCalls.map { it.first to it.second },
            "both calls hit the SAME (mic, playback) cell — confirms this is genuinely a path-only flip, not a cell change",
        )
    }

    @Test
    fun playback_axis_calls_still_collapse_idempotently_with_the_path_guard() = runTest {
        // requestPlayback: a repeat with the SAME enabled value always re-derives path as the
        // (unchanged) currentPath, so the new `&& c.path == currentPath` guard must not
        // regress its pre-existing idempotent collapse.
        val requestVa = FakeVoiceAudio()
        val requestVoice = sdkVoice(requestVa)
        requestVoice.requestPlayback(true); advanceUntilIdle()
        requestVoice.requestPlayback(true); advanceUntilIdle()
        assertEquals(1, requestVa.configureCalls.size, "repeated requestPlayback(true) still collapses to one engine call")
        assertEquals(listOf(VoiceAudioPath.Duplex), requestVa.configuredPaths, "no second path recorded on the collapsed repeat")

        // armPlayback: same invariant — it always passes the tracked currentPath explicitly,
        // so a repeated arm while already playback-active must still collapse.
        val armVa = FakeVoiceAudio()
        val armVoice = sdkVoice(armVa)
        val firstArm = armVoice.armPlayback()
        val secondArm = armVoice.armPlayback()
        assertEquals(true, firstArm)
        assertEquals(true, secondArm, "the collapsed ack still resolves to the correct playback-active result")
        assertEquals(1, armVa.configureCalls.size, "repeated armPlayback still collapses to one engine call")
        assertEquals(listOf(VoiceAudioPath.Duplex), armVa.configuredPaths, "no second path recorded on the collapsed repeat")
    }
}
