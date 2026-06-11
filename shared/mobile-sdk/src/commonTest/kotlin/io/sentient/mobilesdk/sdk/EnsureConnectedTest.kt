// ---------------------------------------------------------------------------
// EnsureConnectedTest — pins the ensureConnected() engagement-surface contract.
//
// KEEPER (per .claude/rules/testing.md): FSM/invariant — the single engagement-
// driven connectivity entry must branch correctly on:
//   READY        → liveness probe only (no new socket)
//   DISCONNECTED → forceReconnect (open a socket)
//   CONNECTING / AUTHENTICATING / RECONNECTING → NO-OP (single-flight guard)
//
// The single-flight guard prevents the double-connect race: ensureConnected
// firing mid-handshake would open a second socket, orphan the first handshake,
// and trigger a 4002 session-ready timeout → reconnect storm.
//
// Drives the real orchestrator over a FakeWebSocketEngine under runTest virtual
// time (same harness as sibling sdk tests).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EnsureConnectedTest {

    private fun pingFrames(sent: List<String>) = sent.filter { it.contains("\"type\":\"ping\"") }

    @Test
    fun ensureConnected_when_disconnected_opens_a_socket() = runTest {
        // Start the SDK in DISCONNECTED state (the initial state, never connected).
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status, "precondition: DISCONNECTED")

        sdk.ensureConnected()
        runCurrent()

        // DISCONNECTED path calls forceReconnect() — opens a new socket.
        assertTrue(
            fake.openedUrls.isNotEmpty(),
            "ensureConnected from DISCONNECTED must open a socket, urls=${fake.openedUrls}",
        )
    }

    @Test
    fun ensureConnected_while_authenticating_is_a_noop_no_double_connect() = runTest {
        // Drive the SDK to AUTHENTICATING: connect is in flight but auth.ok not yet delivered.
        // This is the double-connect race window: ensureConnected firing here must NOT
        // open a second socket — that would orphan the handshake and cause a 4002 storm.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        // Start connect but do NOT deliver auth.ok / session.ready — stays AUTHENTICATING.
        launch { sdk.connect() }
        sdk.connection.first { it.status == SdkStatus.AUTHENTICATING }
        val socketsBefore = fake.openedUrls.size
        assertEquals(SdkStatus.AUTHENTICATING, sdk.connection.value.status, "precondition: AUTHENTICATING")

        // Simulate the engagement signal that caused the race (e.g. composer focus fires
        // ensureConnected while the auth handshake is still in flight).
        sdk.ensureConnected()
        runCurrent()

        // Must be a no-op: no new socket opened, status still AUTHENTICATING.
        assertEquals(socketsBefore, fake.openedUrls.size, "ensureConnected mid-handshake must NOT open a second socket")
        assertEquals(SdkStatus.AUTHENTICATING, sdk.connection.value.status, "status must stay AUTHENTICATING")
    }

    @Test
    fun ensureConnected_when_ready_probes_and_does_not_drop_socket() = runTest {
        // Start the SDK at READY.
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val opensBefore = fake.openedUrls.size

        sdk.ensureConnected()
        runCurrent()

        // READY path delegates to onForeground() — sends a probe ping but does NOT
        // tear down the live socket (stays READY while waiting for pong).
        assertEquals(1, pingFrames(fake.sentText).size, "READY ensureConnected must send exactly one probe ping")
        assertEquals(SdkStatus.READY, sdk.connection.value.status, "READY socket must remain READY during probe")
        assertEquals(opensBefore, fake.openedUrls.size, "probe must NOT open a new socket, urls=${fake.openedUrls}")

        // A pong confirms liveness → stays READY, no reconnect.
        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        runCurrent()
        assertEquals(SdkStatus.READY, sdk.connection.value.status, "pong-confirmed socket stays READY")
        assertEquals(opensBefore, fake.openedUrls.size, "pong must not trigger reconnect")

        // Advance past the probe window — no timeout reconnect since pong already arrived.
        advanceTimeBy(3_001)
        runCurrent()
        assertEquals(SdkStatus.READY, sdk.connection.value.status, "socket stays READY after probe window passes")
        assertEquals(opensBefore, fake.openedUrls.size, "no extra socket opened after pong")
    }
}
