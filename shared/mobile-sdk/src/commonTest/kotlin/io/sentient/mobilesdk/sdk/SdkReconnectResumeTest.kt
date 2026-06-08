// ---------------------------------------------------------------------------
// SdkReconnectResumeTest — pins the A1 session-continuity contract at the
// orchestrator level (replaces the deleted connect-URL SessionResumeTest).
//
// KEEPER (per .claude/rules/testing.md): the reconnect re-establish is an FSM
// invariant + a wire contract with the gateway. The bug it guards:
//   - the OLD connect-URL resume replayed the gateway CONNECTION id → the
//     gateway rejected `forbidden "session not owned by current"`.
// The NEW contract:
//   (a) FIRST connect with no anchored session → NO session.switch (nothing to
//       restore — a phantom switch would churn the gateway).
//   (b) after a session.created(uuid) anchors the ACP session, a RECONNECT that
//       reaches READY fires exactly ONE fire-and-forget session.switch(uuid).
//   (c) the connect URL handed to the engine NEVER contains `session_id` — there
//       is no connect-URL resume anymore.
//
// Drives the real orchestrator over a FakeWebSocketEngine under runTest virtual
// time (mirrors SentientSdkReconnectTest). Each open() mints a FRESH session, so
// `fake.sentText` reads the CURRENT (post-reconnect) session's frames.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SdkReconnectResumeTest {

    private val anchoredUuid = "8f3c1d2e-aaaa-bbbb-cccc-000000000001"

    /** session.created broadcast carrying the real ACP session uuid. */
    private fun createdFrame(uuid: String) =
        "{\"type\":\"session.created\",\"sessionId\":\"$uuid\",\"ts\":1}"

    private fun switchFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"session.switch\"") }

    @Test
    fun first_connect_with_no_anchor_sends_no_session_switch() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        connectToReady(sdk, fake)

        assertEquals(SdkStatus.READY, sdk.connection.value.status)
        assertEquals(null, sdk.currentSessionId.value, "no anchor on a fresh first connect")
        assertTrue(
            switchFrames(fake.sentText).isEmpty(),
            "first connect must NOT send session.switch, sent=${fake.sentText}",
        )
    }

    @Test
    fun reconnect_after_anchor_fires_exactly_one_session_switch_with_uuid() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // Anchor the ACP session uuid via a session.created broadcast (as the
        // gateway emits after a slow mint). currentSessionId must reflect it.
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }

        // Drop the live session → RECONNECTING → the loop re-opens a FRESH socket.
        fake.failIncoming("network drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        sdk.connection.first { fake.openedUrls.size >= 2 }

        // Finish the reconnect handshake to READY on the fresh session. The READY
        // rising edge (a reconnect, not the first connect) must re-establish the
        // anchored session via a single fire-and-forget session.switch(uuid).
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }

        val switches = switchFrames(fake.sentText)
        assertEquals(
            1,
            switches.size,
            "reconnect-READY with an anchor must fire exactly one session.switch, sent=${fake.sentText}",
        )
        assertTrue(
            switches.single().contains(anchoredUuid),
            "the re-establish switch must carry the anchored uuid, frame=${switches.single()}",
        )
    }

    @Test
    fun connect_url_never_contains_session_id() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // Anchor + reconnect so BOTH the first-connect and reconnect open() URLs
        // are recorded — neither may carry a connect-URL resume param.
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        fake.failIncoming("network drop")
        sdk.connection.first { fake.openedUrls.size >= 2 }
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }

        assertTrue(fake.openedUrls.size >= 2, "expected first + reconnect opens, urls=${fake.openedUrls}")
        for (url in fake.openedUrls) {
            assertFalse(url.contains("session_id"), "connect URL must not carry session_id: $url")
        }
    }
}
