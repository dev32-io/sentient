// ---------------------------------------------------------------------------
// AudioPipelineTest — KEEPER (per .claude/rules/testing.md): pins E3 DOWNLINK
// invariants that would only surface in E5/E6 real-audio smoke — late + expensive.
//
// The mic UPLINK (continuous-minus-echo capture → gate → encode) moved to the
// voice/ package in Task 10 (MicSource → VoiceUplinkPipeline); AudioPipeline is
// now downlink-only. This file pins the downlink playback + FSM contracts NOT
// already covered by AudioPipelineDownlinkTest:
//
//   - audio.start opens playback + marks speaking (isSpeaking latch).
//   - a binary frame enqueues to the player.
//   - playback.stop (barge-in / interrupt) flushes the player + routes the FSM
//     ASSISTANT_SPEAKING → INTERRUPTING.
//   - TEXT path: TTS still flips isSpeaking even though the FSM stays INACTIVE
//     (voiceMode OFF) — the isSpeaking/FSM decoupling (webui isAudioPlaying).
//
// Drives a fake playback adapter + a real AudioFsm under runTest virtual time.
// No hardware, no real clock.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineTest {

    // ── Fakes ───────────────────────────────────────────────────────────────────

    private class FakePlayback : AudioPlaybackAdapter {
        var startedRate: Int? = null
        var stopped = false
        var cleared = 0
        var playbackIdle = true
        val enqueued = mutableListOf<ByteArray>()
        override suspend fun start(sampleRate: Int) { startedRate = sampleRate }
        override fun enqueue(pcm16: ByteArray) { enqueued += pcm16 }
        override suspend fun stop() { stopped = true }
        override fun clear() { cleared += 1 }
        override val isPlaybackIdle: Boolean get() = playbackIdle
    }

    private fun pipeline(
        playback: AudioPlaybackAdapter?,
        scope: CoroutineScope,
        fsm: AudioFsm = AudioFsm(),
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
    ): AudioPipeline = AudioPipeline(
        playback = playback,
        opusDecoder = FakeOpusDecoderPort(),
        fsm = fsm,
        scope = scope,
        outputSampleRate = 24000,
        onStateChanged = onStateChanged,
    )

    // ── DOWNLINK: playback + isSpeaking ───────────────────────────────────────────

    @Test
    fun audioStart_opens_playback_and_marks_speaking() = runTest {
        var speaking = false
        val playback = FakePlayback()
        val p = pipeline(playback, this, onStateChanged = { sp, _ -> speaking = sp })
        p.onAudioStart("c1")
        advanceUntilIdle()
        assertEquals(24000, playback.startedRate, "playback opened at output rate")
        assertTrue(speaking, "isSpeaking=true on audio.start")
    }

    @Test
    fun audioFrame_enqueues_to_playback() = runTest {
        val playback = FakePlayback()
        val p = pipeline(playback, this)
        p.onAudioStart("c1")
        // The frame may arrive before start() resolves — allow the coroutine to run
        // so playbackReady flips true and the buffered frame is flushed.
        p.onAudioFrame(byteArrayOf(1, 2, 3, 4), "c1")
        advanceUntilIdle()
        assertEquals(1, playback.enqueued.size)
    }

    @Test
    fun playbackStop_clears_buffer_and_routes_to_interrupting() = runTest {
        val states = mutableListOf<AudioState>()
        val playback = FakePlayback()
        // Voice-mode barge-in: FSM already in ASSISTANT_SPEAKING when playback.stop lands.
        val p = pipeline(
            playback, this,
            fsm = AudioFsm(AudioState.ASSISTANT_SPEAKING),
            onStateChanged = { _, s -> states += s },
        )
        p.onAudioStart("c1")
        p.onPlaybackStop("barge-in", "c1")
        assertEquals(1, playback.cleared, "playback flushed (clear, not stop) on barge-in")
        assertEquals(AudioState.INTERRUPTING, states.last(), "FSM → interrupting on playback.stop")
    }

    @Test
    fun text_path_audio_marks_speaking_even_with_fsm_inactive() = runTest {
        // TEXT path: voiceMode OFF → FSM stays INACTIVE, but TTS still plays so
        // isSpeaking must flip (mirrors webui isAudioPlaying). Pins the decoupling.
        var speaking = false
        var lastState = AudioState.LISTENING
        val p = pipeline(FakePlayback(), this, onStateChanged = { sp, s -> speaking = sp; lastState = s })
        p.onAudioStart("c1")
        assertTrue(speaking, "isSpeaking=true on text-path audio.start")
        assertEquals(AudioState.INACTIVE, lastState, "FSM stays INACTIVE on the text path")
        p.onAudioDone("c1")
        // Held past audio.done while the player drains its tail (mirrors webui isAudioPlaying);
        // clears once the player reports idle + the settle elapses.
        assertTrue(speaking, "isSpeaking held after text-path audio.done while the tail plays")
        advanceUntilIdle()
        assertTrue(!speaking, "isSpeaking clears once the text-path player physically drained")
    }
}
