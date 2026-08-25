package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.voice.talk.TurnMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UserAudioInputConnectorTest {
    private class Recorder {
        val sent = mutableListOf<ClientMessage>()
        val binary = mutableListOf<ByteArray>()
    }

    private fun connector(ids: Iterator<String> = listOf("cap-1", "cap-2", "cap-3").iterator()): Pair<UserAudioInputConnector, Recorder> {
        val rec = Recorder()
        return UserAudioInputConnector(
            send = { rec.sent += it },
            sendBinary = { rec.binary += it },
            createCaptureId = { ids.next() },
        ) to rec
    }

    @Test fun has_capability_audio_input() = assertEquals("audio.input", connector().first.capability)

    @Test
    fun exact_manual_start_and_matching_commit_payloads() {
        val (c, rec) = connector()
        assertEquals("cap-1", c.startStreaming(TurnMode.Manual))
        c.stopStreaming()
        assertEquals(
            listOf(ClientMessage.AudioStart("cap-1", "manual"), ClientMessage.AudioEnd("cap-1")),
            rec.sent,
        )
    }

    @Test
    fun explicit_cancel_wins_and_never_emits_end() {
        val (c, rec) = connector()
        c.startStreaming(TurnMode.Manual)
        c.cancelStreaming()
        c.stopStreaming()
        assertEquals(
            listOf(ClientMessage.AudioStart("cap-1", "manual"), ClientMessage.AudioCancel("cap-1")),
            rec.sent,
        )
    }

    @Test
    fun generation_latched_frames_stop_before_terminal_and_cannot_enter_successor() {
        val (c, rec) = connector()
        val old = c.newCaptureToken()!!
        assertTrue(c.startStreaming(old, TurnMode.Manual))
        val staleSender = c.frameSender(old)
        staleSender(byteArrayOf(1))
        assertTrue(c.beginTerminal(old))
        staleSender(byteArrayOf(2))
        c.completeTerminal(old, CaptureTerminal.Commit)

        val newer = c.newCaptureToken()!!
        assertTrue(c.startStreaming(newer, TurnMode.Semantic))
        staleSender(byteArrayOf(3))
        c.frameSender(newer)(byteArrayOf(4))

        assertEquals(listOf(1.toByte(), 4.toByte()), rec.binary.map { it.single() })
        assertEquals(
            listOf(ClientMessage.AudioStart("cap-1", "manual"), ClientMessage.AudioEnd("cap-1"), ClientMessage.AudioStart("cap-2", "semantic")),
            rec.sent,
        )
    }

    @Test
    fun stale_or_duplicate_terminal_cannot_affect_newer_capture() {
        val (c, rec) = connector()
        val old = c.newCaptureToken()!!
        c.startStreaming(old, TurnMode.Manual)
        c.beginTerminal(old)
        c.completeTerminal(old, CaptureTerminal.Cancel)
        val newer = c.newCaptureToken()!!
        c.startStreaming(newer, TurnMode.Semantic)

        assertTrue(!c.beginTerminal(old))
        c.completeTerminal(old, CaptureTerminal.Commit)
        assertTrue(c.beginTerminal(newer))
        c.completeTerminal(newer, CaptureTerminal.Commit)
        assertEquals(listOf("audio.start", "audio.cancel", "audio.start", "audio.end"), rec.sent.map {
            when (it) {
                is ClientMessage.AudioStart -> "audio.start"
                is ClientMessage.AudioCancel -> "audio.cancel"
                is ClientMessage.AudioEnd -> "audio.end"
                else -> error("unexpected")
            }
        })
    }

    @Test
    fun transcript_callback_remains_compatible() {
        var transcript: String? = null
        val c = UserAudioInputConnector({}, {}, onTranscript = { transcript = it })
        c.handle(ServerMessage.ConnectorTranscriptFinal("hello"))
        c.handle(ServerMessage.Pong)
        assertEquals("hello", transcript)
    }
}
