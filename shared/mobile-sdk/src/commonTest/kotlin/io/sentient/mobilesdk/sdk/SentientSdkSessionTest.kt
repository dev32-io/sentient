// ---------------------------------------------------------------------------
// SentientSdkSessionTest — pins the ConnectionState.hasSession FSM, the
// auth/session signal that gates login↔chat on both native UIs.
//
// KEEPER (per .claude/rules/testing.md): hasSession is an FSM invariant the
// gate divergence depends on (transport-status-gated screens unmounted chat on
// every drop, hiding the connection-lost banner). The contract:
//   reach READY                ⇒ hasSession TRUE
//   transport drop (reconnect) ⇒ hasSession STAYS TRUE  (auto-reconnect)
//   reconnect exhausted        ⇒ hasSession STAYS TRUE  (presence retry later)
//   idle-disconnect            ⇒ hasSession STAYS TRUE  (still "in session")
//   logout (disconnect())      ⇒ hasSession FALSE
//   terminal authExpired       ⇒ hasSession FALSE
//
// Drives the real orchestrator over a FakeWebSocketEngine under runTest virtual
// time (mirrors SentientSdkReconnectTest).
//
// NOTE: deriver_folds_hasSession_into_state called deriver.derive() which is
// removed with the legacy SdkState aggregate. That direct-deriver assertion is
// covered end-to-end by reaching_ready_sets_hasSession_true above.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SentientSdkSessionTest {

    @Test
    fun reaching_ready_sets_hasSession_true() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        assertFalse(sdk.connection.value.hasSession, "hasSession starts false (pre-login)")

        connectToReady(sdk, fake)

        assertTrue(sdk.connection.value.hasSession, "hasSession set on first READY")
    }

    @Test
    fun transport_drop_preserves_hasSession() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        assertTrue(sdk.connection.value.hasSession)

        // Non-clean drop on the READY session → RECONNECTING. The gate must keep
        // showing chat (with the connection-lost banner), so hasSession STAYS true.
        fake.failIncoming("network drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }

        assertTrue(sdk.connection.value.connectionLost, "connectionLost set on drop")
        assertTrue(sdk.connection.value.hasSession, "drop must NOT clear hasSession")
    }

    @Test
    fun reconnect_exhausted_preserves_hasSession() = runTest {
        // After READY, every subsequent open() throws → the reconnect loop
        // exhausts maxAttempts and fires onReconnectExhausted (DISCONNECTED +
        // connectionLost). The "tap to reconnect" CTA lives on chat, so the gate
        // must STAY on chat: hasSession preserved.
        val fake = ReopenFailingEngine()
        val sdk = buildSdk(fake)
        connectToReadyVia(sdk) { fake.emit(it) }
        assertTrue(sdk.connection.value.hasSession)

        fake.failNextOpens = true
        fake.failIncoming("network drop")

        // runTest auto-advances the backoff; the loop surrenders to DISCONNECTED
        // with connectionLost still set (exhausted, not a clean disconnect).
        sdk.connection.first { it.status == SdkStatus.DISCONNECTED && it.connectionLost }
        assertTrue(sdk.connection.value.hasSession, "exhausted reconnect must NOT clear hasSession")
    }

    @Test
    fun idle_disconnect_preserves_hasSession() = runTest {
        // disconnectForIdle() delegates to disconnect(clearSession = false); assert
        // that exact branch keeps the user "in session" (auto-reconnect on presence)
        // while still tearing the WS down to DISCONNECTED.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        assertTrue(sdk.connection.value.hasSession)

        sdk.disconnect(clearSession = false)
        yield()

        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status)
        assertTrue(sdk.connection.value.hasSession, "idle-disconnect must NOT clear hasSession")
    }

    @Test
    fun logout_disconnect_clears_hasSession() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        assertTrue(sdk.connection.value.hasSession)

        // The default disconnect() is the consumer/logout teardown path.
        sdk.disconnect()
        yield()

        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status)
        assertFalse(sdk.connection.value.hasSession, "logout must clear hasSession → gate falls to login")
    }

    @Test
    fun terminal_auth_expired_clears_hasSession() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        // Reach READY once so hasSession is set, then force a terminal auth failure
        // on a fresh attempt (force a drop → reconnect, then auth.error on retry).
        connectToReady(sdk, fake)
        assertTrue(sdk.connection.value.hasSession)

        fake.failIncoming("network drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text("{\"type\":\"auth.error\",\"code\":\"expired\",\"message\":\"x\"}"))
        sdk.connection.first { it.status == SdkStatus.ERROR }

        assertTrue(sdk.connection.value.authExpired, "authExpired set on terminal auth failure")
        assertFalse(sdk.connection.value.hasSession, "authExpired must clear hasSession → gate falls to login")
    }
}

/**
 * FakeWebSocketEngine whose [open] starts throwing once [failNextOpens] flips —
 * used to exhaust the reconnect loop deterministically under virtual time.
 * Delegates the session surface to a wrapped [FakeWebSocketEngine].
 */
private class ReopenFailingEngine : WebSocketEngine {
    private val delegate = FakeWebSocketEngine()
    var failNextOpens: Boolean = false

    val openedUrls: List<String> get() = delegate.openedUrls
    suspend fun emit(frame: WsIncoming) = delegate.emit(frame)
    suspend fun failIncoming(error: String) = delegate.failIncoming(error)

    override suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession {
        if (failNextOpens) throw IllegalStateException("reopen refused")
        return delegate.open(url, allowSelfSignedDevHost)
    }
}

/**
 * Drive the connect handshake to READY against an engine exposed only via an
 * [emit] lambda (used for the wrapper engine that doesn't expose the
 * FakeWebSocketEngine helpers directly). Mirrors SdkTestHarness.connectToReady;
 * launches connect() on the test scope so the emits drive the server side.
 */
private suspend fun TestScope.connectToReadyVia(sdk: SentientSdk, emit: suspend (WsIncoming) -> Unit) {
    val job = launch { sdk.connect() }
    sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
    emit(WsIncoming.Text(AUTH_OK_FRAME))
    emit(WsIncoming.Text(READY_FRAME))
    sdk.connection.first { it.status == SdkStatus.READY }
    job.join()
}
