// ---------------------------------------------------------------------------
// AudioPipelineHoldTest — KEEPER (per .claude/rules/testing.md): pins the buffer-and-defer
// invariant (design spec §7.3) that would otherwise only surface in the proactive-tts-hold
// device case. While TalkMode == Hold the downlink must NEVER arm playback: proactive TTS
// frames buffer (bounded, drop-oldest) and flush IN ORDER on release/lock.
//
// Drives a FakeVoiceAudio whose lazy-arm configures it for playback (mirrors production
// SdkVoice.armPlayback → engine.configure(playback=true)) under runTest virtual time.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineHoldTest {

    private fun pipeline(
        sink: FakeVoiceAudio,
        scope: CoroutineScope,
        holdBufferMaxBytes: Int = 30 * 48_000 * 2,
        playbackDrainSettleMs: Long = 100,
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
    ): AudioPipeline = AudioPipeline(
        playback = sink,
        opusDecoder = FakeOpusDecoderPort(),
        fsm = AudioFsm(),
        scope = scope,
        outputSampleRate = 24_000,
        onStateChanged = onStateChanged,
        playbackDrainSettleMs = playbackDrainSettleMs,
        armPlayback = { sink.configure(mic = false, playback = true); true },
        disarmPlayback = { },
        holdBufferMaxBytes = holdBufferMaxBytes,
    )

    @Test
    fun hold_buffers_downlink_without_arming_then_endHold_flushes_in_order() = runTest {
        var speaking = false
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this, onStateChanged = { sp, _ -> speaking = sp })

        p.beginHold()
        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(1, 2), "c1")
        p.onAudioFrame(byteArrayOf(3, 4), "c1")
        advanceUntilIdle()
        assertEquals(0, sink.playedFrames.size, "no frame plays during Hold")
        assertTrue(!speaking, "isSpeaking stays false during Hold (reply is deferred, not audible)")
        assertTrue(sink.configureCalls.none { it.second }, "playback engine is NEVER armed during Hold")

        p.endHold()
        advanceUntilIdle()
        assertEquals(2, sink.playedFrames.size, "deferred frames flush on endHold")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(1, 2)), "FIFO order — first buffered first out")
        assertTrue(sink.playedFrames[1].contentEquals(byteArrayOf(3, 4)), "FIFO order — second buffered second out")
        assertTrue(speaking, "isSpeaking flips true once the deferred reply arms + plays")
    }

    @Test
    fun hold_buffer_overflow_drops_oldest_keeps_newest() = runTest {
        val sink = FakeVoiceAudio()
        // Tiny bound (5 bytes): each 3-byte frame added past the first forces a drop-oldest.
        val p = pipeline(sink, this, holdBufferMaxBytes = 5)

        p.beginHold()
        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(1, 1, 1), "c1")
        p.onAudioFrame(byteArrayOf(2, 2, 2), "c1")
        p.onAudioFrame(byteArrayOf(3, 3, 3), "c1")
        advanceUntilIdle()
        assertEquals(0, sink.playedFrames.size, "still nothing plays during Hold")

        p.endHold()
        advanceUntilIdle()
        // 3 frames × 3 bytes = 9 > 5-byte bound: only the NEWEST frame survives drop-oldest.
        assertEquals(1, sink.playedFrames.size, "drop-oldest trimmed to the newest frame")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(3, 3, 3)), "newest frame is the survivor")
    }

    @Test
    fun endHold_after_stream_done_flushes_then_drains_and_clears_speaking() = runTest {
        var speaking = false
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        val p = pipeline(sink, this, onStateChanged = { sp, _ -> speaking = sp })

        p.beginHold()
        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(1, 2), "c1")
        p.onAudioDone("c1") // the proactive stream finished SENDING mid-hold
        runCurrent()
        assertEquals(0, sink.playedFrames.size, "nothing plays during Hold even after audio.done")
        assertTrue(!speaking, "not speaking during Hold")

        p.endHold()
        runCurrent() // arm settles → flush → drain-watch armed (player still busy)
        assertEquals(1, sink.playedFrames.size, "buffered reply flushed on release")
        assertTrue(speaking, "speaking HELD while the flushed reply plays out (drain-watch deferred to post-flush)")

        sink.setPlaybackIdle(true)
        advanceTimeBy(50 + 100 + 20)
        runCurrent()
        assertTrue(!speaking, "speaking clears once the flushed reply physically drained + settle elapsed")
    }

    @Test
    fun endHold_is_noop_when_no_tts_arrived_during_hold() = runTest {
        var speaking = false
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this, onStateChanged = { sp, _ -> speaking = sp })

        p.beginHold()
        p.endHold()
        advanceUntilIdle()
        assertEquals(0, sink.playedFrames.size, "clean hold with no proactive TTS plays nothing")
        assertTrue(!speaking, "endHold with an empty buffer never flips speaking")
        assertTrue(sink.configureCalls.isEmpty(), "no engine arm when nothing was buffered")
    }
}
