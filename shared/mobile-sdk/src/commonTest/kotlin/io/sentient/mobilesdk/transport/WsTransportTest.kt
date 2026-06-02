// ---------------------------------------------------------------------------
// WsTransportTest — wire-contract tests for the WS transport boundary.
//
// Pins: ClientMessage → WireJson text frame on send; ByteArray → binary frame
// on sendBinary; incoming TEXT WsIncoming → ServerMessage decode; incoming
// BINARY frames routed to the separate audio stream (NOT the JSON stream);
// Closed/Failure surfaced as TransportSignal lifecycle events. These are
// process-boundary wire contracts → keepers per .claude/rules/testing.md.
//
// FakeWebSocketEngine.open() mints a FRESH WebSocketSession (its own incoming
// channel) each call — subscribe to the session returned by the open() under
// test, never a cached reference (see B1 review caveat).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.protocol.Capabilities
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WsTransportTest {

    // Pump runs in backgroundScope so it is auto-cancelled at test end — the
    // fake's incoming channel stays open in send-only tests, and a regular
    // launch would leave runTest waiting on the never-completing pump.
    private suspend fun TestScope.openTransport(fake: FakeWebSocketEngine): WsTransport {
        val session = fake.open("wss://test/ws", allowSelfSignedDevHost = false)
        return WsTransport(session, scope = backgroundScope)
    }

    @Test
    fun send_encodes_client_message_to_text_frame() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        transport.send(ClientMessage.Auth(token = "tok-123"))

        assertEquals(1, fake.sentText.size)
        val frame = fake.sentText.first()
        assertTrue(frame.contains("\"type\":\"auth\""), "frame=$frame")
        assertTrue(frame.contains("\"token\":\"tok-123\""), "frame=$frame")
    }

    @Test
    fun send_session_configure_carries_client_type() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        transport.send(
            ClientMessage.SessionConfigure(
                capabilities = Capabilities(supports = listOf("audio")),
                clientType = "mobile",
            ),
        )

        val frame = fake.sentText.first()
        assertTrue(frame.contains("\"type\":\"session.configure\""), "frame=$frame")
        assertTrue(frame.contains("\"clientType\":\"mobile\""), "frame=$frame")
    }

    @Test
    fun sendBinary_forwards_bytes_to_session() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)
        val pcm = byteArrayOf(1, 2, 3, 4)

        transport.sendBinary(pcm)

        assertEquals(1, fake.sentBinary.size)
        assertTrue(fake.sentBinary.first().contentEquals(pcm))
    }

    @Test
    fun incoming_text_decodes_to_server_message() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<ServerMessage>()
        val job = launch { transport.incoming.toList(collected) }

        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"session.ready\",\"sessionId\":\"s1\"," +
                    "\"audioEncoding\":\"pcm\",\"inputSampleRate\":16000,\"outputSampleRate\":24000}",
            ),
        )
        fake.closeIncoming()
        job.join()

        assertEquals(2, collected.size)
        assertTrue(collected[0] is ServerMessage.Pong)
        val ready = collected[1] as ServerMessage.SessionReady
        assertEquals("s1", ready.sessionId)
    }

    @Test
    fun unknown_text_frame_decodes_to_unknown_not_throws() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<ServerMessage>()
        val job = launch { transport.incoming.toList(collected) }

        fake.emit(WsIncoming.Text("{\"type\":\"some.future.frame\",\"x\":1}"))
        fake.closeIncoming()
        job.join()

        assertEquals(1, collected.size)
        assertTrue(collected[0] is ServerMessage.Unknown)
    }

    @Test
    fun binary_frames_route_to_audio_stream_not_json_stream() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val json = mutableListOf<ServerMessage>()
        val audio = mutableListOf<ByteArray>()
        val jsonJob = launch { transport.incoming.toList(json) }
        val audioJob = launch { transport.audioFrames.toList(audio) }

        val pcm = byteArrayOf(9, 8, 7)
        fake.emit(WsIncoming.Binary(pcm))
        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        fake.closeIncoming()
        jsonJob.join()
        audioJob.join()

        assertEquals(1, json.size)
        assertTrue(json[0] is ServerMessage.Pong)
        assertEquals(1, audio.size)
        assertTrue(audio[0].contentEquals(pcm))
    }

    @Test
    fun closed_frame_surfaces_as_closed_signal() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val signals = mutableListOf<TransportSignal>()
        val job = launch { transport.signals.toList(signals) }

        fake.closeIncoming(code = WS_NORMAL_CLOSURE, reason = "bye")
        job.join()

        assertEquals(1, signals.size)
        val closed = signals[0] as TransportSignal.Closed
        assertEquals(WS_NORMAL_CLOSURE, closed.code)
    }

    @Test
    fun failure_frame_surfaces_as_failure_signal() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val signals = mutableListOf<TransportSignal>()
        val job = launch { transport.signals.toList(signals) }

        fake.failIncoming("tls-error")
        job.join()

        assertEquals(1, signals.size)
        assertTrue(signals[0] is TransportSignal.Failure)
    }
}
