// ---------------------------------------------------------------------------
// UserAudioInputConnectorTest — ported from web-sdk
// user-audio-input-connector.test.ts. Wire/protocol contract at the
// gateway↔SDK boundary (outbound audio.start / binary frame / audio.end, and
// inbound connector.transcript.final → onTranscript) → keeper per
// .claude/rules/testing.md.
//
// web-sdk reaches the wire via sdk.send + sdk.sendBinary; mobile-sdk injects a
// `send` lambda (control frames) AND a `sendBinary` lambda (PCM uplink). The
// attach/detach lifecycle becomes constructor-injection (the orchestrator owns
// connector lifetime), so the TS "stops streaming on detach" / "does not send
// after detach" cases have no analogue — there is no nullable sdk to clear. The
// isStreaming latch is still ported verbatim (no audio.start when already
// streaming; no binary / audio.end when not streaming).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.voice.talk.TurnMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UserAudioInputConnectorTest {

    private class Recorder {
        val sent = mutableListOf<ClientMessage>()
        val binary = mutableListOf<ByteArray>()
        val send: (ClientMessage) -> Unit = { sent += it }
        val sendBinary: (ByteArray) -> Unit = { binary += it }
    }

    private fun connector(
        rec: Recorder = Recorder(),
        onTranscript: ((String) -> Unit)? = null,
    ): Pair<UserAudioInputConnector, Recorder> =
        UserAudioInputConnector(send = rec.send, sendBinary = rec.sendBinary, onTranscript = onTranscript) to rec

    @Test
    fun has_capability_audio_input() {
        assertEquals("audio.input", connector().first.capability)
    }

    @Test
    fun startStreaming_sends_audio_start() {
        val (c, rec) = connector()
        c.startStreaming()
        // Default (no turnMode) → omitted on the wire (semantic). Back-compat with old clients.
        assertEquals(listOf<ClientMessage>(ClientMessage.AudioStart(turnMode = null)), rec.sent)
    }

    @Test
    fun startStreaming_carries_turnMode_manual() {
        val (c, rec) = connector()
        c.startStreaming(TurnMode.Manual)
        assertEquals(listOf<ClientMessage>(ClientMessage.AudioStart(turnMode = "manual")), rec.sent)
    }

    @Test
    fun startStreaming_carries_turnMode_semantic() {
        val (c, rec) = connector()
        c.startStreaming(TurnMode.Semantic)
        assertEquals(listOf<ClientMessage>(ClientMessage.AudioStart(turnMode = "semantic")), rec.sent)
    }

    @Test
    fun stopStreaming_sends_audio_end() {
        val (c, rec) = connector()
        c.startStreaming()
        c.stopStreaming()
        assertEquals(listOf<ClientMessage>(ClientMessage.AudioStart(turnMode = null), ClientMessage.AudioEnd), rec.sent)
    }

    @Test
    fun sendAudioFrame_forwards_binary_when_streaming() {
        val (c, rec) = connector()
        c.startStreaming()
        val frame = byteArrayOf(1, 2, 3)
        c.sendAudioFrame(frame)
        assertEquals(1, rec.binary.size)
        assertTrue(rec.binary[0].contentEquals(frame))
    }

    @Test
    fun sendAudioFrame_drops_binary_when_not_streaming() {
        val (c, rec) = connector()
        c.sendAudioFrame(byteArrayOf(1, 2, 3))
        assertTrue(rec.binary.isEmpty())
    }

    @Test
    fun startStreaming_is_idempotent_no_duplicate_audio_start() {
        val (c, rec) = connector()
        c.startStreaming()
        c.startStreaming()
        assertEquals(listOf<ClientMessage>(ClientMessage.AudioStart(turnMode = null)), rec.sent)
    }

    @Test
    fun stopStreaming_when_not_streaming_sends_nothing() {
        val (c, rec) = connector()
        c.stopStreaming()
        assertEquals(emptyList<ClientMessage>(), rec.sent)
    }

    @Test
    fun calls_onTranscript_on_connector_transcript_final() {
        var captured: String? = null
        val (c, _) = connector(onTranscript = { captured = it })
        c.handle(io.sentient.mobilesdk.protocol.ServerMessage.ConnectorTranscriptFinal(text = "hello world"))
        assertEquals("hello world", captured)
    }

    @Test
    fun handle_ignores_unowned_frames() {
        val (c, rec) = connector()
        c.handle(io.sentient.mobilesdk.protocol.ServerMessage.Pong)
        c.handle(io.sentient.mobilesdk.protocol.ServerMessage.MessageDelta(cycleId = "c1", delta = "x"))
        assertEquals(emptyList<ClientMessage>(), rec.sent)
        assertTrue(rec.binary.isEmpty())
    }
}
