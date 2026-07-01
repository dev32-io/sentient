// ---------------------------------------------------------------------------
// AudioPipelineDownlinkTest — KEEPER (per .claude/rules/testing.md): pins E3
// DOWNLINK invariants that would only surface in E5/E6 real-audio smoke.
//
// The engine is LAZY-ARMED on audio.start (mirrors web-sdk): frames buffer until the
// async arm settles, then flush in order. Tests advanceUntilIdle() after onAudioStart to
// run the arm. What this pins:
//
//   - opus decode wiring (chunk → PCM → playFrame, in order).
//   - pcm16 passthrough (decoder NOT called).
//   - opus audio.done resets the decoder.
//   - cycle supersede flushes playback + stale frames from the prior cycle are dropped.
//   - drain-watch holds speaking while the player reports busy, clears once idle + settle.
//
// Drives a FakeVoiceAudio via an armPlayback lambda that configures it (mirrors the real
// SdkVoice.armPlayback → engine.configure(playback=true)) under runTest virtual time.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.voice.io.FakeVoiceAudio
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineDownlinkTest {

    // ── Fakes ───────────────────────────────────────────────────────────────────

    /** Pipeline whose lazy-arm configures [sink] for playback (mirrors production). */
    private fun pipeline(
        sink: FakeVoiceAudio?,
        scope: kotlinx.coroutines.CoroutineScope,
        opusDecoder: io.sentient.mobilesdk.audio.opus.OpusDecoderPort = FakeOpusDecoderPort(),
    ): AudioPipeline = AudioPipeline(
        playback = sink,
        opusDecoder = opusDecoder,
        fsm = AudioFsm(),
        scope = scope,
        outputSampleRate = 24000,
        onStateChanged = { _, _ -> },
        armPlayback = { sink?.configure(mic = false, playback = true); true },
        disarmPlayback = { },
    )

    // ── A4: opus-decode downlink wiring ───────────────────────────────────────────

    /** A FakeOpusDecoderPort yielding one canned PCM frame per chunk: chunk byte 0 → PCM tag. */
    private fun cannedDecoder(): FakeOpusDecoderPort =
        FakeOpusDecoderPort { chunk -> listOf(byteArrayOf(100, chunk.firstOrNull() ?: 0)) }

    @Test
    fun opusMode_decodesEachChunk_andFeedsPlayFrameInOrder() = runTest {
        val sink = FakeVoiceAudio()
        val dec = cannedDecoder()
        val p = pipeline(sink, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 24000)
        advanceUntilIdle() // arm settles
        p.onAudioFrame(byteArrayOf(1), "c1")
        p.onAudioFrame(byteArrayOf(2), "c1")

        assertEquals(2, dec.decodedChunks.size, "decoder invoked once per opus chunk")
        assertEquals(2, sink.playedFrames.size, "one PCM frame played per chunk")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(100, 1)), "first decoded frame first")
        assertTrue(sink.playedFrames[1].contentEquals(byteArrayOf(100, 2)), "second decoded frame second")
    }

    @Test
    fun pcm16Mode_passesBytesThrough_withoutCallingDecoder() = runTest {
        val sink = FakeVoiceAudio()
        val dec = FakeOpusDecoderPort()
        val p = pipeline(sink, this, dec)

        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24000)
        advanceUntilIdle() // arm settles
        val raw = byteArrayOf(7, 8, 9, 10)
        p.onAudioFrame(raw, "c1")

        assertEquals(0, dec.decodedChunks.size, "decoder NOT called in pcm16 mode")
        assertEquals(1, sink.playedFrames.size, "raw bytes passed straight to playFrame")
        assertTrue(sink.playedFrames[0].contentEquals(raw), "bytes unchanged")
    }

    @Test
    fun opusDone_resetsDecoder() = runTest {
        val sink = FakeVoiceAudio()
        val dec = cannedDecoder()
        val p = pipeline(sink, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 48000)
        advanceUntilIdle() // arm settles
        val afterStart = dec.resetCount
        p.onAudioDone("c1")

        assertTrue(dec.resetCount > afterStart, "decoder.reset() called on opus audio.done")
    }

    // ── Cycle supersede + physical-drain hold ─────────────────────────────────────

    @Test
    fun newerCycle_supersedesOld_flushesPlayback_andDropsStaleFrames() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)

        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24000)
        advanceUntilIdle() // c1 arm settles
        p.onAudioFrame(byteArrayOf(1), "c1")
        assertEquals(1, sink.playedFrames.size, "c1 frame played")

        // A newer cycle's audio arrives while c1 is still active → flush c1's audio.
        p.onAudioStart("c2", encoding = "pcm16", sampleRate = 24000)
        advanceUntilIdle() // c2 arm settles (already armed → configure no-op, still armed)
        assertTrue(sink.flushCount >= 1, "flushPlayback called when c2 supersedes c1")

        // A late c1 frame is stale → dropped; only the newer c2 frame plays.
        p.onAudioFrame(byteArrayOf(99), "c1")
        p.onAudioFrame(byteArrayOf(2), "c2")
        assertEquals(1, sink.playedFrames.size, "stale c1 frame dropped; only c2's new frame present")
        assertTrue(sink.playedFrames.last().contentEquals(byteArrayOf(2)), "the newest played frame is c2's")
    }

    @Test
    fun speaking_heldWhilePlayerBusy_clearedOnceIdleAndSettled() = runTest {
        var speaking = false
        // Player still draining its tail — start NOT idle.
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        val p = AudioPipeline(
            playback = sink,
            opusDecoder = FakeOpusDecoderPort(),
            fsm = AudioFsm(),
            scope = this,
            outputSampleRate = 24000,
            onStateChanged = { sp, _ -> speaking = sp },
            playbackDrainSettleMs = 100,
            armPlayback = { sink.configure(mic = false, playback = true); true },
            disarmPlayback = { },
        )

        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24000)
        runCurrent() // arm settles (playback active), but player still not idle
        p.onAudioDone("c1")
        // Player still reports busy → speaking is HELD past audio.done.
        advanceTimeBy(500)
        runCurrent()
        assertTrue(speaking, "speaking held while the player reports busy (still draining)")

        // Player drains → the poll (50ms) catches idle, then the 100ms settle elapses.
        sink.setPlaybackIdle(true)
        advanceTimeBy(50 + 100 + 20)
        runCurrent()
        assertTrue(!speaking, "speaking cleared once the player drained + settle elapsed")
    }
}
