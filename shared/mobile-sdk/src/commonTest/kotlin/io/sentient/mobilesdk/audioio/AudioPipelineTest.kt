// ---------------------------------------------------------------------------
// AudioPipelineTest — KEEPER (per .claude/rules/testing.md): pins the E3 voice
// pipeline INVARIANTS that would only surface in E5/E6 real-audio smoke —
// late + expensive. Two load-bearing contracts:
//
//   UPLINK (continuous-minus-echo): every captured frame is forwarded to the
//   uplink connector EXCEPT the frames the EchoGate rejects (echo during
//   playback). The reject→accept onset flushes the pre-roll ring + feeds the
//   FSM a MicOnset.
//
//   DOWNLINK (echoGate playback lifecycle + isSpeaking + clear-on-stop): audio
//   start opens playback + raises the echo threshold + marks speaking; done
//   drains the tail + clears speaking; playback.stop cancels the echo state +
//   flushes the playback buffer (barge-in).
//
// Drives fake capture/playback adapters + a real EchoGate / AudioFsm /
// UserAudioInputConnector under runTest virtual time. No hardware, no real clock.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.EchoGateConfig
import io.sentient.mobilesdk.audio.float32ToPcm16
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineTest {

    // Tuned config — mirrors gateway/webui constants (NOT changed here).
    private val echoCfg = EchoGateConfig(baselineThreshold = 0.03, playbackThreshold = 0.2, tailHoldMs = 800)

    // ── Fakes ───────────────────────────────────────────────────────────────────

    /** Emits a fixed frame list, then completes. Records start/stop. */
    private class FakeCapture(private val out: List<ByteArray>) : AudioCaptureAdapter {
        var started = false
        var stopped = false
        override fun frames(sampleRate: Int): Flow<ByteArray> = flow { for (f in out) emit(f) }
        override suspend fun start(sampleRate: Int) { started = true }
        override suspend fun stop() { stopped = true }
    }

    private class FakePlayback : AudioPlaybackAdapter {
        var startedRate: Int? = null
        var stopped = false
        var cleared = 0
        val enqueued = mutableListOf<ByteArray>()
        override suspend fun start(sampleRate: Int) { startedRate = sampleRate }
        override fun enqueue(pcm16: ByteArray) { enqueued += pcm16 }
        override suspend fun stop() { stopped = true }
        override fun clear() { cleared += 1 }
    }

    private class Sink {
        val sent = mutableListOf<ClientMessage>()
        val binary = mutableListOf<ByteArray>()
    }

    /** A frame of [samples] samples at amplitude [amp] in [-1,1] → PCM16 LE bytes. */
    private fun frame(amp: Float, samples: Int = 64): ByteArray =
        float32ToPcm16(FloatArray(samples) { amp })

    private fun pipeline(
        capture: AudioCaptureAdapter?,
        playback: AudioPlaybackAdapter?,
        scope: kotlinx.coroutines.CoroutineScope,
        clock: FixedClock = FixedClock(0L),
        echoGate: EchoGate = EchoGate(echoCfg),
        fsm: AudioFsm = AudioFsm(),
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
    ): Pair<AudioPipeline, Sink> {
        val sink = Sink()
        val connector = UserAudioInputConnector(
            send = { sink.sent += it },
            sendBinary = { sink.binary += it },
        )
        connector.startStreaming() // latch open so sendAudioFrame forwards.
        val p = AudioPipeline(
            capture = capture,
            playback = playback,
            opusDecoder = FakeOpusDecoderPort(),
            audioInput = { connector },
            echoGate = echoGate,
            fsm = fsm,
            clock = clock,
            scope = scope,
            inputSampleRate = 16000,
            outputSampleRate = 24000,
            preRollFrames = 24,
            onStateChanged = onStateChanged,
        )
        return p to sink
    }

    // ── UPLINK: continuous-minus-echo ────────────────────────────────────────────

    @Test
    fun uplink_drops_quiet_baseline_frame_until_pre_roll_flush_on_onset() = runTest {
        // amp 0.122 (≈4000/32768) clears baseline 0.03; amp 0.015 (≈500) fails it.
        // Sequence: LOUD, QUIET, LOUD.
        //   1. LOUD  → onset (ring empty) → flush [LOUD1]                  → 1 forwarded
        //   2. QUIET → rejected → buffered in the pre-roll ring (NOT sent) → 0 forwarded
        //   3. LOUD  → onset → flush pre-roll [QUIET] + [LOUD2]            → 2 forwarded
        // Net 3: the quiet frame is held back UNTIL the next onset, then flushed as
        // pre-roll so STT sees the quiet utterance head. This is the documented
        // continuous-minus-echo gating (echo dropped in real time; onset padded).
        val capture = FakeCapture(listOf(frame(0.122f), frame(0.015f), frame(0.122f)))
        val (p, sink) = pipeline(capture, FakePlayback(), this)
        p.start()
        advanceUntilIdle()
        assertEquals(3, sink.binary.size, "loud frames + pre-roll-flushed quiet onset")
        assertTrue(capture.started)
    }

    @Test
    fun uplink_drops_pure_echo_frames_during_playback() = runTest {
        // Quiet echo during TTS (RMS below playbackThreshold 0.2) is dropped in
        // real time and never flushed (no following onset). amp 0.061 (≈2000)
        // clears baseline but fails the raised playback threshold.
        val gate = EchoGate(echoCfg)
        val capture = FakeCapture(listOf(frame(0.061f), frame(0.061f)))
        val (p, sink) = pipeline(capture, FakePlayback(), this, echoGate = gate)
        gate.onPlaybackStart("c1") // raise the threshold so the frames read as echo.
        p.start()
        advanceUntilIdle()
        assertEquals(0, sink.binary.size, "pure echo never reaches the wire")
    }

    @Test
    fun uplink_micOnset_drives_fsm_to_user_speaking() = runTest {
        val states = mutableListOf<AudioState>()
        val capture = FakeCapture(listOf(frame(0.122f)))
        val (p, _) = pipeline(capture, FakePlayback(), this, onStateChanged = { _, s -> states += s })
        p.start()
        advanceUntilIdle()
        // Activate → LISTENING, then the loud onset → USER_SPEAKING.
        assertTrue(states.contains(AudioState.LISTENING), "activate→listening: $states")
        assertTrue(states.contains(AudioState.USER_SPEAKING), "onset→user-speaking: $states")
    }

    @Test
    fun stop_cancels_capture_and_resets() = runTest {
        val capture = FakeCapture(emptyList())
        val (p, _) = pipeline(capture, FakePlayback(), this)
        p.start()
        p.stop()
        // stop() launches capture.stop() on the scope; let it run.
        advanceUntilIdle()
        assertTrue(capture.stopped, "capture.stop() paired with flow cancel")
    }

    // ── DOWNLINK: playback + echoGate lifecycle + isSpeaking ──────────────────────

    @Test
    fun audioStart_opens_playback_and_marks_speaking() = runTest {
        var speaking = false
        val playback = FakePlayback()
        val (p, _) = pipeline(null, playback, this, onStateChanged = { sp, _ -> speaking = sp })
        p.onAudioStart("c1")
        advanceUntilIdle()
        assertEquals(24000, playback.startedRate, "playback opened at output rate")
        assertTrue(speaking, "isSpeaking=true on audio.start")
    }

    @Test
    fun audioStart_raises_echo_threshold_to_suppress_echo() = runTest {
        val gate = EchoGate(echoCfg)
        val playback = FakePlayback()
        val (p, _) = pipeline(null, playback, this, echoGate = gate)
        p.onAudioStart("c1")
        // amp 0.061 (≈2000) clears baseline 0.03 but fails playback 0.2 → echo dropped.
        val echo = float32ToPcm16(FloatArray(64) { 0.061f })
        val pcm = ShortArray(echo.size / 2) {
            ((echo[it * 2].toInt() and 0xFF) or (echo[it * 2 + 1].toInt() shl 8)).toShort()
        }
        assertTrue(!gate.acceptFrame(pcm, nowMs = 10), "echo rejected while TTS plays")
    }

    @Test
    fun audioFrame_enqueues_to_playback() = runTest {
        val playback = FakePlayback()
        val (p, _) = pipeline(null, playback, this)
        p.onAudioStart("c1")
        // The frame may arrive before start() resolves — allow the coroutine to run
        // so playbackReady flips true and the buffered frame is flushed.
        p.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        advanceUntilIdle()
        assertEquals(1, playback.enqueued.size)
    }

    @Test
    fun audioDone_clears_speaking_and_drains_tail() = runTest {
        var speaking = true
        val gate = EchoGate(echoCfg)
        val (p, _) = pipeline(null, FakePlayback(), this, echoGate = gate, onStateChanged = { sp, _ -> speaking = sp })
        p.onAudioStart("c1")
        p.onAudioDone("c1")
        assertTrue(!speaking, "isSpeaking=false on audio.done")
        // Gate moved playback→tail; a mid frame still fails the tail threshold.
        val mid = ShortArray(64) { 2000 }
        assertTrue(!gate.acceptFrame(mid, nowMs = 1), "tail still elevated right after drain")
    }

    @Test
    fun playbackStop_clears_buffer_cancels_echo_and_routes_to_interrupting() = runTest {
        val states = mutableListOf<AudioState>()
        val gate = EchoGate(echoCfg)
        val playback = FakePlayback()
        // Voice-mode barge-in: FSM already in ASSISTANT_SPEAKING when playback.stop lands.
        val (p, _) = pipeline(
            null, playback, this,
            echoGate = gate, fsm = AudioFsm(AudioState.ASSISTANT_SPEAKING),
            onStateChanged = { _, s -> states += s },
        )
        p.onAudioStart("c1")
        p.onPlaybackStop("barge-in", "c1")
        assertEquals(1, playback.cleared, "playback flushed (clear, not stop) on barge-in")
        // Echo state back to baseline immediately after cancel.
        val mid = ShortArray(64) { 2000 }
        assertTrue(gate.acceptFrame(mid, nowMs = 1), "echo gate back to baseline after cancel")
        assertEquals(AudioState.INTERRUPTING, states.last(), "FSM → interrupting on playback.stop")
    }

    // ── BARGE-IN: passive (mic-onset over TTS) — distinct from UI-stop ────────────
    //
    // The gateway detects barge-in SERVER-SIDE: the client keeps streaming mic
    // frames during TTS; a loud frame clears the EchoGate's elevated playback
    // threshold and reaches the wire, where STT's turn_started fires the gateway
    // bargeInController (cancel cycle + TTS, KEEP tasks). The client sends NO
    // explicit barge-in frame — and crucially NOT the `interrupt` ClientMessage,
    // which is the DISTINCT UI-stop path that routes task-cancel to Hermes.
    // Evidence: gateway/src/adapters/user-audio-input-adapter.ts (onSpeechOnset →
    // bargeInController.trigger) + ws-handlers.ts case "interrupt" →
    // interruptController.trigger; webui use-voice-client.ts sends `interrupt`
    // only from the Stop button, never on mic-onset.

    @Test
    fun bargeIn_loud_frame_over_tts_forwards_to_uplink_and_routes_to_interrupting() = runTest {
        // Loud barge-in frame must (a) pass the EchoGate's elevated playback
        // threshold so it reaches the uplink connector (the gateway detects it),
        // and (b) drive the FSM ASSISTANT_SPEAKING → INTERRUPTING. amp 0.305
        // (≈10000) clears playback threshold 0.2; a leading silent frame (0.0)
        // is rejected so the loud frame is a reject→accept onset (which flushes
        // the pre-roll head + the loud frame, the documented onset padding).
        val states = mutableListOf<AudioState>()
        val gate = EchoGate(echoCfg)
        val capture = FakeCapture(listOf(frame(0.0f), frame(0.305f)))
        // Voice-mode barge-in: mic uplink already active (FSM ASSISTANT_SPEAKING
        // once TTS started). Seed the FSM there, mirroring the live sequence
        // start()→Activate→…→onAudioStart→ASSISTANT_SPEAKING.
        val (p, sink) = pipeline(
            capture, FakePlayback(), this,
            echoGate = gate, fsm = AudioFsm(AudioState.ASSISTANT_SPEAKING),
            onStateChanged = { _, s -> states += s },
        )
        // TTS is playing: audio.start raises the echo threshold + isSpeaking true.
        p.onAudioStart("cycle-7")
        p.start()
        advanceUntilIdle()
        // Passive barge-in: the loud frame reached the uplink (server-detected).
        // The onset flushes the pre-roll (leading silent frame) + the loud frame.
        assertTrue(sink.binary.isNotEmpty(), "loud barge-in frame forwarded to uplink")
        assertEquals(AudioState.INTERRUPTING, states.last(), "barge-in → FSM interrupting")
    }

    @Test
    fun bargeIn_does_not_send_interrupt_control_message() = runTest {
        // The DISTINCT-from-UI-stop invariant: barge-in is passive. The pipeline
        // must NEVER emit the `interrupt` ClientMessage on the mic-onset path —
        // that frame is reserved for the explicit UI-stop (sdk.interrupt()), which
        // the gateway routes to task-cancel. Sending it on barge-in would wrongly
        // cancel the user's running tasks.
        val gate = EchoGate(echoCfg)
        val capture = FakeCapture(listOf(frame(0.061f), frame(0.305f)))
        val (p, sink) = pipeline(capture, FakePlayback(), this, echoGate = gate)
        p.onAudioStart("cycle-7")
        p.start()
        advanceUntilIdle()
        assertTrue(
            sink.sent.none { it is ClientMessage.Interrupt },
            "barge-in must NOT send the task-cancelling interrupt frame: ${sink.sent}",
        )
    }

    @Test
    fun text_path_audio_marks_speaking_even_with_fsm_inactive() = runTest {
        // TEXT path: voiceMode OFF → FSM stays INACTIVE, but TTS still plays so
        // isSpeaking must flip (mirrors webui isAudioPlaying). Pins the decoupling.
        var speaking = false
        var lastState = AudioState.LISTENING
        val (p, _) = pipeline(null, FakePlayback(), this, onStateChanged = { sp, s -> speaking = sp; lastState = s })
        p.onAudioStart("c1")
        assertTrue(speaking, "isSpeaking=true on text-path audio.start")
        assertEquals(AudioState.INACTIVE, lastState, "FSM stays INACTIVE on the text path")
        p.onAudioDone("c1")
        assertTrue(!speaking, "isSpeaking=false on text-path audio.done")
    }
}
