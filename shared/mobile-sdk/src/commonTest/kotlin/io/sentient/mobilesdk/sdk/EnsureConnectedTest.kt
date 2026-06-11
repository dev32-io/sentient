// ---------------------------------------------------------------------------
// EnsureConnectedTest — pins the ensureConnected() engagement-surface contract.
//
// KEEPER (per .claude/rules/testing.md): FSM/invariant — the single engagement-
// driven connectivity entry must branch correctly on READY (probe only) vs.
// not-READY (reconnect). Mirrors ForegroundProbeTest for the probe case and
// SentientSdkReconnectTest for the reconnect case.
//
// Drives the real orchestrator over a FakeWebSocketEngine under runTest virtual
// time (same harness as sibling sdk tests).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EnsureConnectedTest {

    private fun pingFrames(sent: List<String>) = sent.filter { it.contains("\"type\":\"ping\"") }

    @Test
    fun ensureConnected_when_not_ready_reconnects() = runTest {
        // Start the SDK in DISCONNECTED state (the initial state, never connected).
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        assertTrue(sdk.connection.value.status != SdkStatus.READY, "precondition: not READY")

        sdk.ensureConnected()
        runCurrent()

        // Not-READY path calls forceReconnect() — opens a new socket (reconnect attempt).
        assertTrue(
            fake.openedUrls.isNotEmpty(),
            "not-ready ensureConnected must reconnect (open a socket), urls=${fake.openedUrls}",
        )
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
