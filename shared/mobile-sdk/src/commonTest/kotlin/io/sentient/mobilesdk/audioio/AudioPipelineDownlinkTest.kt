// ---------------------------------------------------------------------------
// AudioPipelineDownlinkTest — KEEPER (per .claude/rules/testing.md): pins the
// pre-start frame-buffering contract (E3 downlink invariant).
//
// Root cause: playback.start() is async (scope.launch); the first downlink frame
// arrives before start() resolves → null player → frame dropped → ~0.33s clipped
// off every spoken reply on both platforms.
//
// Fix: frames buffer in pendingFrames until playbackReady flips true, then flush
// in order. Barge-in (onPlaybackStop) discards the buffer and resets the state.
//
// Tests use a FakeSlowPlayback whose start() suspends until a CompletableDeferred
// is released — this makes the race deterministic under runTest virtual time.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.audio.EchoGate
import io.sentient.mobilesdk.audio.EchoGateConfig
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.fakes.FakeOpusDecoderPort
import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.sdk.AudioFsm
import io.sentient.mobilesdk.sdk.AudioState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioPipelineDownlinkTest {

    private val echoCfg = EchoGateConfig(baselineThreshold = 0.03, playbackThreshold = 0.2, tailHoldMs = 800)

    // ── Fakes ───────────────────────────────────────────────────────────────────

    /**
     * Playback adapter whose start() suspends until [gate] is completed.
     * Records enqueue calls in order so tests can assert frame delivery.
     */
    private class FakeSlowPlayback(private val gate: CompletableDeferred<Unit>) : AudioPlaybackAdapter {
        val enqueued = mutableListOf<ByteArray>()
        var startCalled = false
        var startRate = -1
        var stopped = false
        var cleared = 0

        override suspend fun start(sampleRate: Int) {
            startCalled = true
            startRate = sampleRate
            gate.await()
        }

        override fun enqueue(pcm16: ByteArray) { enqueued += pcm16 }
        override suspend fun stop() { stopped = true }
        override fun clear() { cleared += 1 }
    }

    private class FakeCapture : AudioCaptureAdapter {
        override fun frames(sampleRate: Int): Flow<ByteArray> = emptyFlow()
        override suspend fun start(sampleRate: Int) {}
        override suspend fun stop() {}
    }

    private fun pipeline(
        playback: AudioPlaybackAdapter?,
        scope: kotlinx.coroutines.CoroutineScope,
        opusDecoder: io.sentient.mobilesdk.audio.opus.OpusDecoderPort = FakeOpusDecoderPort(),
    ): AudioPipeline {
        val connector = UserAudioInputConnector(send = {}, sendBinary = {})
        connector.startStreaming()
        return AudioPipeline(
            capture = FakeCapture(),
            playback = playback,
            opusDecoder = opusDecoder,
            audioInput = { connector },
            echoGate = EchoGate(echoCfg),
            fsm = AudioFsm(),
            clock = FixedClock(0L),
            scope = scope,
            inputSampleRate = 16000,
            outputSampleRate = 24000,
            preRollFrames = 24,
            onStateChanged = { _, _ -> },
        )
    }

    // ── Tests ───────────────────────────────────────────────────────────────────

    @Test
    fun framesArrivingBeforeStartCompletesAreBufferedAndFlushedInOrder() = runTest {
        val gate = CompletableDeferred<Unit>()
        val pb = FakeSlowPlayback(gate)
        val p = pipeline(pb, this)

        // Audio starts — start() is suspended waiting for the gate.
        p.onAudioStart("c1")

        // Two frames arrive before start() resolves.
        val frameA = byteArrayOf(1, 2)
        val frameB = byteArrayOf(3, 4)
        p.onAudioFrame(frameA, "c1")
        p.onAudioFrame(frameB, "c1")

        // Nothing enqueued yet — player not ready.
        assertEquals(0, pb.enqueued.size, "no frame enqueued before start() completes")

        // Release the gate — start() unblocks; pipeline flushes the buffer.
        gate.complete(Unit)
        advanceUntilIdle()

        // Both frames delivered in order, none dropped.
        assertEquals(2, pb.enqueued.size, "both frames flushed after start() completes")
        assertTrue(pb.enqueued[0].contentEquals(frameA), "frame A delivered first")
        assertTrue(pb.enqueued[1].contentEquals(frameB), "frame B delivered second")
    }

    @Test
    fun framesAfterReadyEnqueueDirectly() = runTest {
        val gate = CompletableDeferred<Unit>()
        val pb = FakeSlowPlayback(gate)
        val p = pipeline(pb, this)

        p.onAudioStart("c1")
        gate.complete(Unit)
        advanceUntilIdle() // playbackReady is now true

        val frameC = byteArrayOf(5, 6, 7, 8)
        p.onAudioFrame(frameC, "c1")

        // Frame goes directly to the player without buffering.
        assertEquals(1, pb.enqueued.size, "post-ready frame enqueued directly")
        assertTrue(pb.enqueued[0].contentEquals(frameC))
    }

    @Test
    fun bargeInBeforeStartCompletesDiscardsBufferedFrames() = runTest {
        val gate = CompletableDeferred<Unit>()
        val pb = FakeSlowPlayback(gate)
        val p = pipeline(pb, this)

        p.onAudioStart("c1")
        p.onAudioFrame(byteArrayOf(9, 10), "c1") // buffered

        // Barge-in fires while start() is still suspended.
        p.onPlaybackStop("barge-in", "c1")

        // Now release the gate — start() completes but the guard checks
        // playbackStarted (reset by onPlaybackStop) and skips the flush.
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(0, pb.enqueued.size, "buffered frames discarded on barge-in — not played")
        assertEquals(1, pb.cleared, "playback.clear() called on barge-in")
    }

    // ── A4: opus-decode downlink wiring ───────────────────────────────────────────

    /** Playback whose start() resolves immediately; records the rate it opened at. */
    private class FakeInstantPlayback : AudioPlaybackAdapter {
        val enqueued = mutableListOf<ByteArray>()
        var startRate = -1
        var cleared = 0
        override suspend fun start(sampleRate: Int) { startRate = sampleRate }
        override fun enqueue(pcm16: ByteArray) { enqueued += pcm16 }
        override suspend fun stop() {}
        override fun clear() { cleared += 1 }
    }

    /** A FakeOpusDecoderPort yielding one canned PCM frame per chunk: chunk byte 0 → PCM tag. */
    private fun cannedDecoder(): FakeOpusDecoderPort =
        FakeOpusDecoderPort { chunk -> listOf(byteArrayOf(100, chunk.firstOrNull() ?: 0)) }

    @Test
    fun opusMode_decodesEachChunk_andEnqueuesInOrder() = runTest {
        val pb = FakeInstantPlayback()
        val dec = cannedDecoder()
        val p = pipeline(pb, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 24000)
        advanceUntilIdle() // playbackReady true

        p.onAudioFrame(byteArrayOf(1), "c1")
        p.onAudioFrame(byteArrayOf(2), "c1")

        assertEquals(2, dec.decodedChunks.size, "decoder invoked once per opus chunk")
        assertEquals(2, pb.enqueued.size, "one PCM frame enqueued per chunk")
        assertTrue(pb.enqueued[0].contentEquals(byteArrayOf(100, 1)), "first decoded frame first")
        assertTrue(pb.enqueued[1].contentEquals(byteArrayOf(100, 2)), "second decoded frame second")
    }

    @Test
    fun opusMode_framesBeforeReadyAreBuffered_thenFlushedInOrder() = runTest {
        val gate = CompletableDeferred<Unit>()
        val pb = FakeSlowPlayback(gate)
        val dec = cannedDecoder()
        val p = pipeline(pb, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 48000)
        // Two opus chunks decode before start() resolves → decoded PCM buffered.
        p.onAudioFrame(byteArrayOf(1), "c1")
        p.onAudioFrame(byteArrayOf(2), "c1")
        assertEquals(0, pb.enqueued.size, "decoded frames buffered before player ready")

        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(2, pb.enqueued.size, "buffered decoded frames flushed after start()")
        assertTrue(pb.enqueued[0].contentEquals(byteArrayOf(100, 1)), "decoded frame A first")
        assertTrue(pb.enqueued[1].contentEquals(byteArrayOf(100, 2)), "decoded frame B second")
    }

    @Test
    fun pcm16Mode_passesBytesThrough_withoutCallingDecoder() = runTest {
        val pb = FakeInstantPlayback()
        val dec = FakeOpusDecoderPort()
        val p = pipeline(pb, this, dec)

        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 24000)
        advanceUntilIdle()

        val raw = byteArrayOf(7, 8, 9, 10)
        p.onAudioFrame(raw, "c1")

        assertEquals(0, dec.decodedChunks.size, "decoder NOT called in pcm16 mode")
        assertEquals(1, pb.enqueued.size, "raw bytes passed straight through")
        assertTrue(pb.enqueued[0].contentEquals(raw), "bytes unchanged")
    }

    @Test
    fun opusMode_startsPlaybackAt48k_ignoringAnnouncedRate() = runTest {
        val pb = FakeInstantPlayback()
        val p = pipeline(pb, this)
        // Announced sampleRate is 24000 but opus always decodes to 48000.
        p.onAudioStart("c1", encoding = "opus", sampleRate = 24000)
        advanceUntilIdle()
        assertEquals(48000, pb.startRate, "opus mode opens playback at 48 kHz regardless of announced rate")
    }

    @Test
    fun pcm16Mode_startsPlaybackAtAnnouncedRate() = runTest {
        val pb = FakeInstantPlayback()
        val p = pipeline(pb, this)
        p.onAudioStart("c1", encoding = "pcm16", sampleRate = 16000)
        advanceUntilIdle()
        assertEquals(16000, pb.startRate, "pcm16 mode opens playback at the announced rate")
    }

    @Test
    fun pcm16Mode_fallsBackToOutputSampleRate_whenNoneAnnounced() = runTest {
        val pb = FakeInstantPlayback()
        val p = pipeline(pb, this)
        p.onAudioStart("c1") // no encoding/sampleRate → pcm16, outputSampleRate fallback (24000)
        advanceUntilIdle()
        assertEquals(24000, pb.startRate, "pcm16 fallback uses outputSampleRate")
    }

    @Test
    fun opusBargeIn_discardsPending_resetsDecoder_andNextStartDecodesCleanly() = runTest {
        val gate = CompletableDeferred<Unit>()
        val pb = FakeSlowPlayback(gate)
        val dec = cannedDecoder()
        val p = pipeline(pb, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 48000)
        val resetsAfterStart = dec.resetCount // audio.start resets once in opus mode
        p.onAudioFrame(byteArrayOf(1), "c1") // decoded → buffered (player not ready)

        // Barge-in while start() still suspended.
        p.onPlaybackStop("barge-in", "c1")
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(0, pb.enqueued.size, "decoded frames discarded on opus barge-in")
        assertEquals(1, pb.cleared, "playback.clear() called on barge-in")
        assertTrue(dec.resetCount > resetsAfterStart, "decoder.reset() called on opus barge-in")

        // Next cycle decodes cleanly — fresh start resets again and frames flow.
        val gate2 = CompletableDeferred<Unit>()
        // Reuse the same pipeline + decoder: a second start re-arms playback.
        p.onAudioStart("c2", encoding = "opus", sampleRate = 48000)
        assertTrue(dec.resetCount >= resetsAfterStart + 2, "next audio.start resets the decoder again")
    }

    @Test
    fun opusDone_resetsDecoder() = runTest {
        val pb = FakeInstantPlayback()
        val dec = cannedDecoder()
        val p = pipeline(pb, this, dec)

        p.onAudioStart("c1", encoding = "opus", sampleRate = 48000)
        val afterStart = dec.resetCount
        advanceUntilIdle()
        p.onAudioDone("c1")

        assertTrue(dec.resetCount > afterStart, "decoder.reset() called on opus audio.done")
    }
}
