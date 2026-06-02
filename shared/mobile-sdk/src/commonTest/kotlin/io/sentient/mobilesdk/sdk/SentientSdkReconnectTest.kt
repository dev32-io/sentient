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
import io.sentient.mobilesdk.transport.AUTH_TIMEOUT_MS
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.currentTime
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
    fun reconnect_controller_rearms_across_disconnect_reconnect_cycle() = runTest {
        // BUG #1 regression — the SdkHolder is a process singleton reused across
        // logout→login. disconnect() cancels the ReconnectController; a later
        // connect() MUST re-arm it (reset the cancelled latch) so a subsequent
        // unexpected drop STILL recovers instead of getting stuck RECONNECTING
        // forever on an immediate cancelled-exit.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        // Cycle 1: connect → READY → consumer disconnect (logout). This cancels
        // the reconnect controller — the bug left it permanently cancelled.
        connectToReady(sdk, fake)
        sdk.disconnect()
        yield()
        assertEquals(SdkStatus.DISCONNECTED, sdk.state.value.status)

        // Cycle 2: connect AGAIN on the SAME sdk instance → READY (login).
        connectToReady(sdk, fake)
        assertEquals(SdkStatus.READY, sdk.state.value.status)
        val opensBeforeDrop = fake.openedUrls.size

        // Now drop the reused-singleton's live session. With the controller
        // re-armed, the signal watch must STILL drive RECONNECTING and the loop
        // must STILL attempt a fresh open() — proving reset() cleared cancel().
        fake.failIncoming("network drop")
        sdk.state.first { it.status == SdkStatus.RECONNECTING }
        assertTrue(sdk.state.value.connectionLost, "connectionLost set on post-relogin drop")

        sdk.state.first { fake.openedUrls.size > opensBeforeDrop }
        assertTrue(
            fake.openedUrls.size > opensBeforeDrop,
            "re-armed controller must re-open, opens=${fake.openedUrls.size} before=$opensBeforeDrop",
        )

        // And it recovers fully to READY on the fresh session.
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.state.first { it.status == SdkStatus.READY }
        assertEquals(SdkStatus.READY, sdk.state.value.status)
    }

    @Test
    fun pre_ready_unexpected_close_fails_fast_into_recoverable_state() = runTest {
        // BUG #2 regression — a non-clean close DURING the handshake
        // (AUTHENTICATING) must NOT hang the full AUTH/READY timeout (10s) and
        // must NOT leave status stuck CONNECTING/AUTHENTICATING. It mirrors
        // web-sdk handleSocketClose `wasLive` (connecting|authenticating|ready):
        // fail the in-flight handshake FAST + drive the recovery path.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        val connectJob = launch { sdk.connect() }
        sdk.state.first { it.status == SdkStatus.AUTHENTICATING }
        val timeAtAuth = currentTime

        // Drop the socket mid-handshake — BEFORE any auth.ok / session.ready.
        fake.failIncoming("gateway down at login")

        // Fast-fail: connect()'s handshake withTimeout must be unblocked by the
        // transport-close → failPending, NOT burn the full AUTH_TIMEOUT_MS. The
        // SDK must land in a RECOVERABLE state (RECONNECTING with an active loop),
        // never stuck CONNECTING/AUTHENTICATING.
        sdk.state.first { it.status == SdkStatus.RECONNECTING }
        val elapsed = currentTime - timeAtAuth
        assertTrue(
            elapsed < AUTH_TIMEOUT_MS,
            "pre-ready close must fail fast (well under ${AUTH_TIMEOUT_MS}ms), elapsed=$elapsed",
        )
        assertTrue(sdk.state.value.connectionLost, "connectionLost set on pre-ready drop")
        connectJob.join()

        // Recoverable: the recovery loop re-opens (fresh session) and drives to READY.
        sdk.state.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.state.first { it.status == SdkStatus.READY }
        assertEquals(SdkStatus.READY, sdk.state.value.status)
    }

    @Test
    fun force_reconnect_drives_fresh_attempt_to_ready_from_error() = runTest {
        // #3 — forceReconnect() is the presence/foreground manual-retry surface
        // the device contract relies on (and resolves the SdkStatus ERROR-state
        // doc that referenced it). From a terminal ERROR/connectionLost state it
        // re-arms the controller, clears authExpired, and drives a fresh attempt.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        // Land in terminal ERROR via an auth.error during the handshake.
        val connectJob = launch { sdk.connect() }
        sdk.state.first { it.status == SdkStatus.AUTHENTICATING }
        fake.emit(WsIncoming.Text("{\"type\":\"auth.error\",\"code\":\"expired\",\"message\":\"x\"}"))
        sdk.state.first { it.status == SdkStatus.ERROR }
        connectJob.join()
        assertTrue(sdk.state.value.authExpired, "authExpired set on terminal auth failure")
        val opensBeforeRetry = fake.openedUrls.size

        // Manual retry: forceReconnect → RECONNECTING + fresh open() → READY.
        sdk.forceReconnect()
        sdk.state.first { it.status == SdkStatus.RECONNECTING }
        sdk.state.first { fake.openedUrls.size > opensBeforeRetry }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.state.first { it.status == SdkStatus.READY }

        assertEquals(SdkStatus.READY, sdk.state.value.status)
        assertTrue(!sdk.state.value.authExpired, "authExpired cleared by forceReconnect recovery")
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
