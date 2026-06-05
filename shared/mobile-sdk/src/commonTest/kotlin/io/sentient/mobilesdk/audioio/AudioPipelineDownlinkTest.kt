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
        var stopped = false
        var cleared = 0

        override suspend fun start(sampleRate: Int) {
            startCalled = true
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
    ): AudioPipeline {
        val connector = UserAudioInputConnector(send = {}, sendBinary = {})
        connector.startStreaming()
        return AudioPipeline(
            capture = FakeCapture(),
            playback = playback,
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
}
