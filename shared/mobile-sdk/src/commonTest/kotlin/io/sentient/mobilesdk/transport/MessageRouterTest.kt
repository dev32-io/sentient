// ---------------------------------------------------------------------------
// MessageRouterTest — routing-correctness tests for ServerMessage dispatch.
//
// Pins the dispatch model mirrored from web-sdk's sdk-message-router.ts: a
// decoded [ServerMessage] is broadcast to every registered connector, each of
// which filters internally via its own handle(); binary audio frames route to
// the audio connector ONLY (never broadcast); unknown / unhandled frames are
// ignored without error (DEBUG only). This is the FSM/wire dispatch contract
// at the SDK boundary → keeper per .claude/rules/testing.md.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.connectors.Connector
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Records every message + binary frame it is handed, regardless of type. */
private class RecordingConnector(override val capability: String) : Connector {
    val handled = mutableListOf<ServerMessage>()
    val handledBinary = mutableListOf<ByteArray>()
    override fun handle(msg: ServerMessage) {
        handled += msg
    }
    override fun handleBinary(bytes: ByteArray) {
        handledBinary += bytes
    }
}

/** Records only the message types it cares about; ignores the rest. */
private class FilteringConnector(override val capability: String) : Connector {
    val handled = mutableListOf<ServerMessage>()
    override fun handle(msg: ServerMessage) {
        if (msg is ServerMessage.ConnectorTranscriptFinal) handled += msg
    }
}

class MessageRouterTest {

    @Test
    fun route_broadcasts_message_to_every_connector() {
        val a = RecordingConnector("cap.a")
        val b = RecordingConnector("cap.b")
        val router = MessageRouter(connectors = listOf(a, b))

        val msg = ServerMessage.TurnTextDelta(turnId = "c1", text = "hi")
        router.route(msg)

        assertEquals(listOf<ServerMessage>(msg), a.handled)
        assertEquals(listOf<ServerMessage>(msg), b.handled)
    }

    @Test
    fun route_lets_each_connector_filter_internally() {
        val filtering = FilteringConnector("cap.transcript")
        val router = MessageRouter(connectors = listOf(filtering))

        router.route(ServerMessage.TurnTextDelta(turnId = "c1", text = "ignored"))
        val transcript = ServerMessage.ConnectorTranscriptFinal(text = "hello")
        router.route(transcript)

        assertEquals(listOf<ServerMessage>(transcript), filtering.handled)
    }

    @Test
    fun route_unknown_frame_is_ignored_without_error() {
        val a = RecordingConnector("cap.a")
        val router = MessageRouter(connectors = listOf(a))

        // Must not throw. The connector still receives it (it filters internally),
        // but the router itself treats Unknown as a no-op decision (DEBUG log).
        router.route(ServerMessage.Unknown)

        assertEquals(listOf<ServerMessage>(ServerMessage.Unknown), a.handled)
    }

    @Test
    fun route_with_no_connectors_does_not_throw() {
        val router = MessageRouter(connectors = emptyList())
        router.route(ServerMessage.Pong)
        router.routeBinary(byteArrayOf(1, 2, 3))
    }

    @Test
    fun routeBinary_forwards_only_to_audio_connector() {
        val audio = RecordingConnector("assistant.audio.response")
        val other = RecordingConnector("cap.other")
        val router = MessageRouter(
            connectors = listOf(audio, other),
            audioConnector = audio,
        )

        val pcm = byteArrayOf(9, 8, 7)
        router.routeBinary(pcm)

        assertEquals(1, audio.handledBinary.size)
        assertTrue(audio.handledBinary[0].contentEquals(pcm))
        assertTrue(other.handledBinary.isEmpty(), "binary must NOT broadcast to non-audio connectors")
    }

    @Test
    fun routeBinary_without_audio_connector_is_ignored_without_error() {
        val other = RecordingConnector("cap.other")
        val router = MessageRouter(connectors = listOf(other))

        router.routeBinary(byteArrayOf(1, 2))

        assertTrue(other.handledBinary.isEmpty())
    }
}
