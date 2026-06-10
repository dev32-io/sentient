// ---------------------------------------------------------------------------
// WsTransportTest — wire-contract tests for the WS transport boundary.
//
// Pins: ClientMessage → WireJson text frame on send; ByteArray → binary frame
// on sendBinary; incoming TEXT WsIncoming → ServerMessage decode (WsEvent.Control);
// incoming BINARY frames → WsEvent.Audio on the SAME ordered event stream; the
// control/audio interleave is preserved in EXACT arrival order (audio.done never
// overtakes the trailing audio frames it terminates); Closed/Failure surfaced as
// TransportSignal lifecycle events. These are process-boundary wire contracts →
// keepers per .claude/rules/testing.md.
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
                deviceId = "dev-abc",
            ),
        )

        val frame = fake.sentText.first()
        assertTrue(frame.contains("\"type\":\"session.configure\""), "frame=$frame")
        assertTrue(frame.contains("\"clientType\":\"mobile\""), "frame=$frame")
        assertTrue(frame.contains("\"deviceId\":\"dev-abc\""), "frame=$frame")
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

        val collected = mutableListOf<WsEvent>()
        val job = launch { transport.events.toList(collected) }

        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"session.ready\",\"sessionId\":\"s1\"," +
                    "\"audioEncoding\":\"pcm\",\"inputSampleRate\":16000,\"outputSampleRate\":24000}",
            ),
        )
        fake.closeIncoming()
        job.join()

        val controls = collected.filterIsInstance<WsEvent.Control>()
        assertEquals(2, controls.size)
        assertTrue(controls[0].message is ServerMessage.Pong)
        val ready = controls[1].message as ServerMessage.SessionReady
        assertEquals("s1", ready.sessionId)
    }

    @Test
    fun unknown_text_frame_decodes_to_unknown_not_throws() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<WsEvent>()
        val job = launch { transport.events.toList(collected) }

        fake.emit(WsIncoming.Text("{\"type\":\"some.future.frame\",\"x\":1}"))
        fake.closeIncoming()
        job.join()

        val controls = collected.filterIsInstance<WsEvent.Control>()
        assertEquals(1, controls.size)
        assertTrue(controls[0].message is ServerMessage.Unknown)
    }

    /**
     * Build a gateway-framed binary audio frame: [8B BE u64 seq][1B type=audio][payload].
     * The transport peels this header and delivers ONLY the payload as WsEvent.Audio.
     */
    private fun framedAudio(seq: Long, payload: ByteArray): ByteArray {
        val out = ByteArray(BINARY_HEADER_BYTES + payload.size)
        for (i in 0 until 8) out[i] = ((seq shr (8 * (7 - i))) and 0xFF).toByte()
        out[8] = BINARY_TYPE_AUDIO.toByte()
        payload.copyInto(out, BINARY_HEADER_BYTES)
        return out
    }

    @Test
    fun binary_frames_peel_header_and_surface_payload_with_seq() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<WsEvent>()
        val job = launch { transport.events.toList(collected) }

        val pcm = byteArrayOf(9, 8, 7)
        fake.emit(WsIncoming.Binary(framedAudio(seq = 42, payload = pcm)))
        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        fake.closeIncoming()
        job.join()

        val audio = collected.filterIsInstance<WsEvent.Audio>()
        val controls = collected.filterIsInstance<WsEvent.Control>()
        assertEquals(1, audio.size)
        // The 9-byte header is stripped — only the payload reaches the audio pipeline.
        assertTrue(audio[0].bytes.contentEquals(pcm), "payload=${audio[0].bytes.toList()}")
        assertEquals(42L, audio[0].seq)
        assertEquals(1, controls.size)
        assertTrue(controls[0].message is ServerMessage.Pong)
    }

    @Test
    fun binary_frame_shorter_than_header_is_dropped() = runTest {
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<WsEvent>()
        val job = launch { transport.events.toList(collected) }

        // 4 bytes < 9-byte header → malformed/truncated → dropped, pump continues.
        fake.emit(WsIncoming.Binary(byteArrayOf(1, 2, 3, 4)))
        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        fake.closeIncoming()
        job.join()

        assertEquals(0, collected.filterIsInstance<WsEvent.Audio>().size)
        assertEquals(1, collected.filterIsInstance<WsEvent.Control>().size)
    }

    @Test
    fun events_preserve_exact_control_audio_interleave_order() = runTest {
        // The wire contract: trailing audio frames arrive BEFORE the control
        // frame that terminates them (connector.audio.done). One ordered event
        // stream must surface them in EXACT arrival order so audio.done can never
        // overtake/lag the audio — this is the bug this fix pins.
        val fake = FakeWebSocketEngine()
        val transport = openTransport(fake)

        val collected = mutableListOf<WsEvent>()
        val job = launch { transport.events.toList(collected) }

        val b1 = byteArrayOf(1, 1, 1)
        val b2 = byteArrayOf(2, 2, 2)
        fake.emit(WsIncoming.Text("{\"type\":\"connector.audio.start\"}"))
        fake.emit(WsIncoming.Binary(framedAudio(seq = 1, payload = b1)))
        fake.emit(WsIncoming.Binary(framedAudio(seq = 2, payload = b2)))
        fake.emit(WsIncoming.Text("{\"type\":\"connector.audio.done\"}"))
        fake.closeIncoming()
        job.join()

        assertEquals(4, collected.size, "events=$collected")
        val start = collected[0] as WsEvent.Control
        assertTrue(start.message is ServerMessage.ConnectorAudioStart, "first=$start")
        // Payloads (header peeled) preserve EXACT arrival order between the controls.
        assertTrue((collected[1] as WsEvent.Audio).bytes.contentEquals(b1))
        assertTrue((collected[2] as WsEvent.Audio).bytes.contentEquals(b2))
        val done = collected[3] as WsEvent.Control
        assertTrue(done.message is ServerMessage.ConnectorAudioDone, "last=$done")
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
