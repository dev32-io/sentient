// ---------------------------------------------------------------------------
// ForegroundProbeTest — pins the foreground liveness-probe contract.
//
// KEEPER (per .claude/rules/testing.md): an FSM/behavior invariant with a
// documented learning. We do NOT drop the socket on background; on foreground we
// send ONE ping and reconnect ONLY if no pong returns in the window. The bug this
// guards: the old resume() always forceReconnect()ed, which on a still-alive
// socket triggered a needless reconnect → full conversation.snapshot replay
// (visible reload) + audio teardown.
//
// Drives the real orchestrator over a FakeWebSocketEngine under runTest virtual
// time (mirrors SdkReconnectResumeTest).
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

class ForegroundProbeTest {

    private fun pingFrames(sent: List<String>) = sent.filter { it.contains("\"type\":\"ping\"") }

    @Test
    fun foreground_when_ready_and_pong_arrives_does_NOT_reconnect() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        val opensBefore = fake.openedUrls.size

        // Returning to the foreground sends exactly one ping…
        sdk.onForeground()
        runCurrent()
        assertEquals(1, pingFrames(fake.sentText).size, "foreground must send exactly one ping, sent=${fake.sentText}")

        // …and a pong proves the socket is alive → no reconnect, no new socket.
        fake.emit(WsIncoming.Text("{\"type\":\"pong\"}"))
        runCurrent()

        assertEquals(SdkStatus.READY, sdk.connection.value.status, "live socket stays READY")
        assertEquals(opensBefore, fake.openedUrls.size, "a pong must NOT open a new socket, urls=${fake.openedUrls}")
    }

    @Test
    fun foreground_when_ready_and_no_pong_reconnects_after_timeout() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        sdk.onForeground()
        runCurrent()
        assertTrue(pingFrames(fake.sentText).isNotEmpty(), "foreground sends a ping")

        // No pong arrives. Past the probe window the socket is treated as dead and
        // the SDK reconnects — opening a SECOND socket (the reconnect loop opens
        // immediately, then sits in AUTHENTICATING awaiting an auth.ok that never comes).
        advanceTimeBy(3_001) // default foregroundProbeTimeoutMs = 3000
        runCurrent()

        assertTrue(
            fake.openedUrls.size >= 2,
            "a timed-out probe must reconnect (open a new socket), urls=${fake.openedUrls}",
        )
        assertTrue(sdk.connection.value.status != SdkStatus.READY, "left READY on reconnect")
    }

    @Test
    fun foreground_when_not_ready_reconnects_immediately() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        // Never reached READY — status is the initial DISCONNECTED.
        assertTrue(sdk.connection.value.status != SdkStatus.READY)

        sdk.onForeground()
        runCurrent()

        // No ping on a not-ready socket; it goes straight to a reconnect (opens a socket).
        assertTrue(pingFrames(fake.sentText).isEmpty(), "no probe ping when not READY")
        assertTrue(fake.openedUrls.isNotEmpty(), "not-ready foreground reconnects (opens a socket), urls=${fake.openedUrls}")
    }
}
