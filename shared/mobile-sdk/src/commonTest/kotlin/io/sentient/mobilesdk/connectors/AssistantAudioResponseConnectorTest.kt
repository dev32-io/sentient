// ---------------------------------------------------------------------------
// AssistantAudioResponseConnectorTest — ported from web-sdk
// assistant-audio-response-connector.test.ts. FSM/drop-guard contract:
//   connector.audio.start → onAudioStart(cycleId), isReceiving=true, clears cancel
//   binary frame while receiving && !cancelled → onAudioFrame(bytes, cycleId)
//   binary frame before start OR after cancel → dropped (no callback)
//   connector.audio.done → isReceiving=false, onAudioDone (unless cancelled)
//   playback.stop → isCancelled=true, isReceiving=false, onPlaybackStop(reason,cycleId)
//   next connector.audio.start re-enables playback (clears cancel latch)
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
        val done = mutableListOf<String>()
        val stopped = mutableListOf<Pair<String, String>>()
    }

    private fun connector(sink: Sink = Sink()): Pair<AssistantAudioResponseConnector, Sink> =
        AssistantAudioResponseConnector(
            onAudioStart = { sink.started += it },
            onAudioFrame = { bytes, cycleId -> sink.frames += bytes to cycleId },
            onAudioDone = { sink.done += it },
            onPlaybackStop = { reason, cycleId -> sink.stopped += reason to cycleId },
        ) to sink

    @Test
    fun has_capability_audio_output() {
        assertEquals("audio.output", connector().first.capability)
    }

    @Test
    fun audio_start_calls_onAudioStart_with_cycleId_and_sets_receiving() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-xyz"))
        assertEquals(listOf("cycle-xyz"), sink.started)
        assertTrue(c.isReceiving())
    }

    @Test
    fun binary_during_active_stream_calls_onAudioFrame_with_cycleId() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-123"))
        val pcm = byteArrayOf(4, 5, 6)
        c.handleBinary(pcm)
        assertEquals(1, sink.frames.size)
        assertTrue(sink.frames[0].first.contentEquals(pcm))
        assertEquals("cycle-123", sink.frames[0].second)
    }

    @Test
    fun binary_before_start_is_dropped() {
        val (c, sink) = connector()
        c.handleBinary(byteArrayOf(1, 2, 3))
        assertTrue(sink.frames.isEmpty())
    }

    @Test
    fun audio_done_calls_onAudioDone_with_cycleId_and_clears_receiving() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-abc"))
        c.handle(ServerMessage.ConnectorAudioDone(cycleId = "cycle-abc"))
        assertEquals(listOf("cycle-abc"), sink.done)
        assertTrue(!c.isReceiving())
    }

    @Test
    fun audio_done_falls_back_to_active_cycleId_when_absent() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-fallback"))
        c.handle(ServerMessage.ConnectorAudioDone(cycleId = null))
        assertEquals(listOf("cycle-fallback"), sink.done)
    }

    @Test
    fun playback_stop_sets_cancel_latch_and_calls_onPlaybackStop() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-1"))
        c.handle(ServerMessage.PlaybackStop(cycleId = "cycle-1", reason = "interrupt"))
        assertEquals(listOf("interrupt" to "cycle-1"), sink.stopped)
        assertTrue(c.isCancelled())
        assertTrue(!c.isReceiving())
    }

    @Test
    fun playback_stop_defaults_reason_to_barge_in_when_absent() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-1"))
        c.handle(ServerMessage.PlaybackStop(cycleId = "cycle-1", reason = null))
        assertEquals(listOf("barge-in" to "cycle-1"), sink.stopped)
    }

    @Test
    fun binary_after_playback_stop_is_dropped() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-1"))
        c.handle(ServerMessage.PlaybackStop(cycleId = "cycle-1", reason = "barge-in"))
        c.handleBinary(byteArrayOf(7, 8, 9))
        assertTrue(sink.frames.isEmpty(), "frames after playback.stop must be dropped until next audio.start")
    }

    @Test
    fun audio_done_after_playback_stop_does_not_call_onAudioDone() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-1"))
        c.handle(ServerMessage.PlaybackStop(cycleId = "cycle-1", reason = "barge-in"))
        c.handle(ServerMessage.ConnectorAudioDone(cycleId = "cycle-1"))
        assertTrue(sink.done.isEmpty(), "done suppressed while cancelled")
    }

    @Test
    fun next_audio_start_clears_cancel_latch_and_re_enables_frames() {
        val (c, sink) = connector()
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-1"))
        c.handle(ServerMessage.PlaybackStop(cycleId = "cycle-1", reason = "barge-in"))
        // New stream — cancel latch cleared, frames flow again.
        c.handle(ServerMessage.ConnectorAudioStart(cycleId = "cycle-2"))
        assertTrue(!c.isCancelled())
        c.handleBinary(byteArrayOf(1))
        assertEquals(1, sink.frames.size)
        assertEquals("cycle-2", sink.frames[0].second)
    }

    @Test
    fun handle_ignores_unowned_frames() {
        val (c, sink) = connector()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "x"))
        assertTrue(sink.started.isEmpty() && sink.done.isEmpty() && sink.stopped.isEmpty())
        assertTrue(!c.isReceiving())
    }
}
