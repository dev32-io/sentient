// ---------------------------------------------------------------------------
// AudioPipelineTurnQueueTest — KEEPER (.claude/rules/testing.md): pins the design
// §7.2 invariant "the gateway never stops its own audio; a new turnId QUEUES BEHIND".
// Pre-2.0 the pipeline treated a different id as a SUPERSEDE and called flushPlayback(),
// cutting the tail off every self-initiated follow-up turn. That regression is invisible
// in unit-free code and expensive to catch on-device, so it is pinned here.
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

class AudioPipelineTurnQueueTest {

    private fun pipeline(
        sink: FakeVoiceAudio,
        scope: CoroutineScope,
        fsm: AudioFsm = AudioFsm(),
        onStateChanged: (Boolean, AudioState) -> Unit = { _, _ -> },
        opusDecoder: io.sentient.mobilesdk.audio.opus.OpusDecoderPort = FakeOpusDecoderPort(),
    ): AudioPipeline = AudioPipeline(
        playback = sink,
        opusDecoder = opusDecoder,
        fsm = fsm,
        scope = scope,
        outputSampleRate = 24_000,
        onStateChanged = onStateChanged,
        playbackDrainSettleMs = 100,
        armPlayback = { sink.configure(mic = false, playback = true); true },
        disarmPlayback = { },
    )

    @Test
    fun followUpTurn_whilePriorTurnStillDraining_neverFlushes() = runTest {
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioDone("t1") // gateway finished SENDING t1; the speaker is still draining

        // The follow-up turn's audio arrives while t1's tail is still in the player.
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(2), "t2")

        assertEquals(0, sink.flushCount, "a new turnId must NEVER flush in-flight audio (§7.2)")
        assertEquals(2, sink.playedFrames.size, "t2's frame is appended behind t1's, not instead of it")
        assertTrue(sink.playedFrames[0].contentEquals(byteArrayOf(1)), "t1's frame stays first")
        assertTrue(sink.playedFrames[1].contentEquals(byteArrayOf(2)), "t2's frame plays after it")
    }

    @Test
    fun overlappingTurn_buffersBehindHead_thenDrainsInOrderOnHeadDone() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")

        // t2 opens BEFORE t1 finished streaming → its bytes must wait, not interleave.
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(20), "t2")
        p.onAudioFrame(byteArrayOf(21), "t2")
        p.onAudioFrame(byteArrayOf(2), "t1")
        assertEquals(2, sink.playedFrames.size, "only the head turn's frames reach the player")

        p.onAudioDone("t1")
        advanceUntilIdle()
        assertEquals(0, sink.flushCount, "promotion is not a flush")
        assertEquals(
            listOf(1.toByte(), 2.toByte(), 20.toByte(), 21.toByte()),
            sink.playedFrames.map { it[0] },
            "t2's buffered frames drain after t1's, in arrival order",
        )
    }

    @Test
    fun speakingHeldAcrossTheQueue_clearsOnlyAfterTheLastTurnDrains() = runTest {
        var speaking = false
        var state = AudioState.INACTIVE
        val sink = FakeVoiceAudio(initialPlaybackIdle = false)
        // Start the FSM LISTENING (mic up): AudioStart only reaches ASSISTANT_SPEAKING from a
        // live state, so an INACTIVE (text-path) FSM could not exercise the queue-exit row.
        val p = pipeline(
            sink,
            this,
            fsm = AudioFsm(AudioState.LISTENING),
            onStateChanged = { sp, st -> speaking = sp; state = st },
        )

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        runCurrent()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(2), "t2")
        p.onAudioDone("t1")
        advanceTimeBy(500)
        runCurrent()
        assertTrue(speaking, "speaking is held while a queued turn is still to play")

        p.onAudioDone("t2")
        runCurrent() // arm the drain watch; NEVER advanceUntilIdle while the player reports busy
        sink.setPlaybackIdle(true)
        advanceTimeBy(50 + 100 + 20)
        runCurrent()
        assertTrue(!speaking, "speaking clears once the LAST queued turn physically drained")
        assertEquals(AudioState.LISTENING, state, "FSM leaves ASSISTANT_SPEAKING only at the end of the queue")
    }

    @Test
    fun playbackStop_flushesEverything_includingQueuedTurns() = runTest {
        val sink = FakeVoiceAudio()
        val p = pipeline(sink, this)

        p.onAudioStart("t1", encoding = "pcm16", sampleRate = 24_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "pcm16", sampleRate = 24_000)
        p.onAudioFrame(byteArrayOf(2), "t2")

        p.onPlaybackStop(reason = "barge-in", turnId = "t1")
        assertEquals(1, sink.flushCount, "barge-in is the ONLY thing that flushes")

        // The queue is gone: a late frame for the dropped turn must not resurrect it.
        p.onAudioFrame(byteArrayOf(3), "t2")
        assertEquals(0, sink.playedFrames.size, "no audio survives a barge-in flush")
    }

    @Test
    fun queuedOpusTurn_isNotDecodedUntilPromoted() = runTest {
        val sink = FakeVoiceAudio()
        val dec = FakeOpusDecoderPort { chunk -> listOf(byteArrayOf(100, chunk.first())) }
        val p = pipeline(sink, this, opusDecoder = dec)

        p.onAudioStart("t1", encoding = "opus", sampleRate = 48_000)
        advanceUntilIdle()
        p.onAudioFrame(byteArrayOf(1), "t1")
        p.onAudioStart("t2", encoding = "opus", sampleRate = 48_000)
        p.onAudioFrame(byteArrayOf(2), "t2")

        assertEquals(1, dec.decodedChunks.size, "a queued turn's chunks must not enter the head turn's decoder")

        p.onAudioDone("t1")
        advanceUntilIdle()
        assertEquals(2, dec.decodedChunks.size, "the queued chunk decodes once its turn is promoted")
    }
}
