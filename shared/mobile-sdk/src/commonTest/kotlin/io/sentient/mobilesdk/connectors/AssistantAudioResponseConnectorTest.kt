// ---------------------------------------------------------------------------
// AssistantAudioResponseConnectorTest — ported from web-sdk
// assistant-audio-response-connector.test.ts. FSM/drop-guard contract:
//   turn.audio.start → onAudioStart(turnId), isReceiving=true, clears cancel
//   binary frame while receiving && !cancelled → onAudioFrame(bytes, turnId)
//   binary frame before start OR after cancel → dropped (no callback)
//   turn.audio.done → isReceiving=false, onAudioDone (unless cancelled)
//   playback.stop → isCancelled=true, isReceiving=false, onPlaybackStop(reason,turnId)
//   next turn.audio.start re-enables playback (clears cancel latch)
// This is the barge-in / interrupt drop-guard FSM → keeper per
// .claude/rules/testing.md.
//
// web-sdk receives PCM via sdk.onBinary; mobile-sdk receives it via the router
// calling handleBinary(bytes) (this connector is the router's audioConnector).
// web-sdk's onCancelled() (effect-cancel hook) maps to the same latch as
// playback.stop; mobile-sdk drives the latch through the playback.stop frame.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AssistantAudioResponseConnectorTest {

    private class Sink {
        val frames = mutableListOf<Pair<ByteArray, String>>()
        val started = mutableListOf<String>()
        val startMeta = mutableListOf<Pair<String?, Int?>>()
        val done = mutableListOf<String>()
        val stopped = mutableListOf<Pair<String, String>>()
    }

    private fun connector(sink: Sink = Sink()): Pair<AssistantAudioResponseConnector, Sink> =
        AssistantAudioResponseConnector(
            onAudioStart = { turnId, encoding, sampleRate ->
                sink.started += turnId
                sink.startMeta += encoding to sampleRate
            },
            onAudioFrame = { bytes, turnId -> sink.frames += bytes to turnId },
            onAudioDone = { sink.done += it },
            onPlaybackStop = { reason, turnId -> sink.stopped += reason to turnId },
        ) to sink

    @Test
    fun has_capability_audio_output() {
        assertEquals("audio.output", connector().first.capability)
    }

    @Test
    fun audio_start_calls_onAudioStart_with_turnId_and_sets_receiving() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-xyz"))
        assertEquals(listOf("turn-xyz"), sink.started)
        assertTrue(c.isReceiving())
    }

    @Test
    fun audio_start_forwards_encoding_and_sampleRate_to_onAudioStart() {
        // JUSTIFIED DIVERGENCE from web-sdk: mobile SDK owns opus decode, so the
        // connector must forward turn.audio.start's encoding + sampleRate.
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "c1", encoding = "opus", sampleRate = 48000))
        assertEquals(listOf<Pair<String?, Int?>>("opus" to 48000), sink.startMeta)
    }

    @Test
    fun binary_during_active_stream_calls_onAudioFrame_with_turnId() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-123"))
        val pcm = byteArrayOf(4, 5, 6)
        c.handleBinary(pcm)
        assertEquals(1, sink.frames.size)
        assertTrue(sink.frames[0].first.contentEquals(pcm))
        assertEquals("turn-123", sink.frames[0].second)
    }

    @Test
    fun binary_before_start_is_dropped() {
        val (c, sink) = connector()
        c.handleBinary(byteArrayOf(1, 2, 3))
        assertTrue(sink.frames.isEmpty())
    }

    @Test
    fun audio_done_calls_onAudioDone_with_turnId_and_clears_receiving() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-abc"))
        c.handle(ServerMessage.TurnAudioDone(turnId = "turn-abc"))
        assertEquals(listOf("turn-abc"), sink.done)
        assertTrue(!c.isReceiving())
    }

    @Test
    fun audio_done_falls_back_to_active_turnId_when_absent() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-fallback"))
        c.handle(ServerMessage.TurnAudioDone(turnId = ""))
        assertEquals(listOf("turn-fallback"), sink.done)
    }

    @Test
    fun playback_stop_sets_cancel_latch_and_calls_onPlaybackStop() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-1"))
        c.handle(ServerMessage.PlaybackStop(turnId = "turn-1", reason = "interrupt"))
        assertEquals(listOf("interrupt" to "turn-1"), sink.stopped)
        assertTrue(c.isCancelled())
        assertTrue(!c.isReceiving())
    }

    @Test
    fun playback_stop_defaults_reason_to_barge_in_when_absent() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-1"))
        c.handle(ServerMessage.PlaybackStop(turnId = "turn-1", reason = ""))
        assertEquals(listOf("barge-in" to "turn-1"), sink.stopped)
    }

    @Test
    fun binary_after_playback_stop_is_dropped() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-1"))
        c.handle(ServerMessage.PlaybackStop(turnId = "turn-1", reason = "barge-in"))
        c.handleBinary(byteArrayOf(7, 8, 9))
        assertTrue(sink.frames.isEmpty(), "frames after playback.stop must be dropped until next audio.start")
    }

    @Test
    fun audio_done_after_playback_stop_does_not_call_onAudioDone() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-1"))
        c.handle(ServerMessage.PlaybackStop(turnId = "turn-1", reason = "barge-in"))
        c.handle(ServerMessage.TurnAudioDone(turnId = "turn-1"))
        assertTrue(sink.done.isEmpty(), "done suppressed while cancelled")
    }

    @Test
    fun next_audio_start_clears_cancel_latch_and_re_enables_frames() {
        val (c, sink) = connector()
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-1"))
        c.handle(ServerMessage.PlaybackStop(turnId = "turn-1", reason = "barge-in"))
        // New stream — cancel latch cleared, frames flow again.
        c.handle(ServerMessage.TurnAudioStart(turnId = "turn-2"))
        assertTrue(!c.isCancelled())
        c.handleBinary(byteArrayOf(1))
        assertEquals(1, sink.frames.size)
        assertEquals("turn-2", sink.frames[0].second)
    }

    @Test
    fun handle_ignores_unowned_frames() {
        val (c, sink) = connector()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.TurnTextDelta(turnId = "c1", text = "x"))
        assertTrue(sink.started.isEmpty() && sink.done.isEmpty() && sink.stopped.isEmpty())
        assertTrue(!c.isReceiving())
    }
}
