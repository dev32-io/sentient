// ---------------------------------------------------------------------------
// SentientSdkReconnectTest — reconnect-on-signal + web-sdk-parity derivation
// contracts for the C7 orchestrator.
//
// KEEPER (per .claude/rules/testing.md): pins the WsTransport-signal →
// ReconnectController wiring (the flagged critical path) and the two
// deriveMessages / transcript-clear parity contracts the native UIs depend on.
// Drives a FakeWebSocketEngine over runTest virtual time; the default delayFn
// (kotlinx delay) is auto-advanced by runTest so the backoff is never waited on
// for real.
//
// B1 caveat: FakeWebSocketEngine mints a FRESH session per open(); the reconnect
// re-opens a new session and the harness helpers drive THAT (current) session.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SentientSdkReconnectTest {

    @Test
    fun unexpected_failure_while_ready_drives_reconnecting_then_reconnects() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        // First open() is the live session. open() count = 1, auth was sent once.
        assertEquals(1, fake.openedUrls.size)

        // Non-clean drop on the READY session: failIncoming completes the incoming
        // flow → WsTransport surfaces TransportSignal.Failure → signal watch sees
        // status==READY and fires onConnectionDrop → status flips to RECONNECTING
        // and the reconnect loop launches attemptConnect() (a fresh engine.open()).
        fake.failIncoming("network drop")
        sdk.state.first { it.status == SdkStatus.RECONNECTING }
        assertTrue(sdk.state.value.connectionLost, "connectionLost set on drop")

        // The reconnect loop's first attempt re-opens the socket. runTest virtual
        // time auto-advances past the backoff delay (default delayFn = delay()),
        // so no real wait is needed; gate on the second open() landing.
        sdk.state.first { fake.openedUrls.size >= 2 }
        assertTrue(fake.openedUrls.size >= 2, "reconnect re-opened the socket, opens=${fake.openedUrls.size}")
        // B1: the reconnect opened a FRESH session (its own channel + send record).
        // Auth was re-sent on it; the harness drives that current session.
        assertTrue(fake.sentText.any { it.contains("\"type\":\"auth\"") }, "auth re-sent on reconnect=${fake.sentText}")

        // Finish the reconnect handshake to READY on the fresh session.
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.state.first { it.status == SdkStatus.READY }
        assertEquals(SdkStatus.READY, sdk.state.value.status)
        assertTrue(!sdk.state.value.connectionLost, "connectionLost cleared on READY")
    }

    @Test
    fun clean_disconnect_does_not_trigger_reconnect() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        assertEquals(1, fake.openedUrls.size)

        // Consumer-initiated disconnect: marks consumerDisconnected + cancels the
        // reconnect controller + closes the socket cleanly. The signal watch must
        // suppress reconnect; a normal-closure signal is ignored regardless.
        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.state.value.status)

        // No second open(): a clean disconnect never re-dials.
        assertEquals(1, fake.openedUrls.size, "clean disconnect must not reconnect, opens=${fake.openedUrls.size}")
        assertTrue(!sdk.state.value.connectionLost, "clean disconnect leaves connectionLost false")
    }

    @Test
    fun tool_and_trigger_feed_entries_are_dropped_from_messages() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // A snapshot carrying user + tool + trigger + assistant entries. Per
        // cycle-helpers.ts deriveMessages parity, ONLY user + assistant render;
        // tool (surfaced via tasks) and trigger (Phase-2 sensor) are dropped.
        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"conversation.snapshot\",\"items\":[" +
                    "{\"kind\":\"user\",\"ts\":10,\"channel\":\"text\",\"content\":\"hi\"}," +
                    "{\"kind\":\"tool\",\"ts\":20,\"toolName\":\"speak\",\"status\":\"finished\",\"summary\":\"spoke\"}," +
                    "{\"kind\":\"trigger\",\"ts\":30,\"source\":\"timer\",\"summary\":\"fired\"}," +
                    "{\"kind\":\"assistant\",\"ts\":40,\"content\":\"hello\"}]}",
            ),
        )
        sdk.state.first { it.messages.isNotEmpty() }

        val roles = sdk.state.value.messages.map { it.role }
        assertEquals(listOf("user", "assistant"), roles, "tool+trigger must be dropped, msgs=${sdk.state.value.messages}")
    }

    @Test
    fun transcript_clears_when_matching_speech_user_entry_commits() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // Live STT preview lands first.
        fake.emit(WsIncoming.Text("{\"type\":\"connector.transcript.final\",\"text\":\"turn on the lights\"}"))
        sdk.state.first { it.transcript == "turn on the lights" }

        // The finalized speech user entry commits with matching content → the live
        // preview is now stale and must clear (web-sdk use-voice-client parity).
        fake.emit(
            WsIncoming.Text(
                "{\"type\":\"conversation.entry\",\"item\":" +
                    "{\"kind\":\"user\",\"ts\":100,\"channel\":\"speech\",\"content\":\"turn on the lights\"}}",
            ),
        )
        sdk.state.first { it.transcript.isEmpty() }
        assertEquals("", sdk.state.value.transcript)
    }
}
