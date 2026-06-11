// ---------------------------------------------------------------------------
// ColdReconnectActivateTest — pins the two halves of the "no orphan on cold
// reconnect" hardening (Task 2.3, ws-resilience):
//
//   Part A — a COLD reconnect (anchor present, resume cursor EMPTY / lastSeq==0)
//     RE-ESTABLISHES the existing conversation by id: it fires exactly one
//     conversation.activate carrying the anchored uuid and sends NO fresh mint
//     (session.new). The orphan bug was a cold reconnect that minted a new
//     conversation instead. Existing tests pin the no-cursor → clear-and-activate
//     decision (SdkResumeReconciliationTest) and the activate-carries-uuid shape
//     (SdkReconnectResumeTest); THIS test unifies the gap — empty cursor AND the
//     activate payload AND the no-fresh-mint negative — in one place.
//
//   Part B — when the gateway REJECTS that re-establish with
//     `sessions.error code=forbidden` (the only case where the owned session was
//     truly dropped server-side), the SDK clears the anchor AND emits a one-shot
//     SdkEvent.ReopenFailed so the UI can tell the user a fresh chat will start.
//
// KEEPER (per .claude/rules/testing.md): FSM invariant + wire contract with the
// gateway (conversation.activate by id, never a phantom mint) + the no-loss
// ReopenFailed notice on the events SharedFlow.
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest virtual
// time. Each open() mints a FRESH session, so `fake.sentText` reads the CURRENT
// (post-reconnect) session's frames.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ColdReconnectActivateTest {

    private val anchoredUuid = "8f3c1d2e-aaaa-bbbb-cccc-0000000000aa"

    /** session.created broadcast carrying the real ACP session uuid. */
    private fun createdFrame(uuid: String) =
        "{\"type\":\"session.created\",\"sessionId\":\"$uuid\",\"ts\":1}"

    /** sessions.error forbidden — the gateway rejecting a re-establish (owned session dropped). */
    private fun forbiddenFrame() =
        "{\"type\":\"sessions.error\",\"requestId\":\"r1\",\"code\":\"forbidden\"," +
            "\"message\":\"session not owned by current user\"}"

    private fun activateFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"conversation.activate\"") }

    private fun newChatFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"session.new\"") }

    /** Anchor the ACP uuid, drop, and re-open a fresh socket — leaving the reconnect
     *  handshake at AUTH_OK/READY for the caller to drive. The cursor is NEVER advanced
     *  (no seq-stamped frame), so this is a COLD reconnect: lastSeq stays 0. */
    private suspend fun anchorAndDropToReopen(
        sdk: SentientSdk,
        fake: FakeWebSocketEngine,
    ) {
        fake.emit(WsIncoming.Text(createdFrame(anchoredUuid)))
        sdk.currentSessionId.first { it == anchoredUuid }
        fake.failIncoming("network drop")
        sdk.connection.first { it.status == SdkStatus.RECONNECTING }
        sdk.connection.first { fake.openedUrls.size >= 2 }
    }

    @Test
    fun cold_reconnect_with_empty_cursor_activates_anchor_and_does_not_mint() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        anchorAndDropToReopen(sdk, fake)

        // Reconnect READY: a cold reconnect (anchor + empty cursor) must re-establish
        // the EXISTING conversation by id, not mint a new one.
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()

        val activates = activateFrames(fake.sentText)
        assertEquals(
            1,
            activates.size,
            "cold reconnect must fire exactly one conversation.activate, sent=${fake.sentText}",
        )
        assertTrue(
            activates.single().contains(anchoredUuid),
            "the activate must re-establish the ANCHORED conversation by id, frame=${activates.single()}",
        )
        assertTrue(
            newChatFrames(fake.sentText).isEmpty(),
            "a cold reconnect must NEVER mint a fresh conversation (no session.new), sent=${fake.sentText}",
        )
    }

    @Test
    fun forbidden_during_reestablish_clears_anchor_and_emits_reopen_failed() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // Collect events BEFORE the forbidden lands (replay=0 — a late subscriber misses it).
        val events = mutableListOf<SdkEvent>()
        val collectJob = launch { sdk.events.collect { events.add(it) } }
        runCurrent()

        anchorAndDropToReopen(sdk, fake)

        // Reconnect READY → fires the re-establish conversation.activate(uuid).
        fake.emit(WsIncoming.Text(AUTH_OK_FRAME))
        fake.emit(WsIncoming.Text(READY_FRAME))
        sdk.connection.first { it.status == SdkStatus.READY }
        runCurrent()
        assertEquals(1, activateFrames(fake.sentText).size, "reconnect re-establishes via conversation.activate")

        // The gateway rejects it — the owned session was dropped server-side.
        fake.emit(WsIncoming.Text(forbiddenFrame()))
        sdk.currentSessionId.first { it == null }
        runCurrent()

        // (a) anchor cleared so the next send mints fresh; (b) one-shot ReopenFailed surfaced.
        assertEquals(null, sdk.currentSessionId.value, "forbidden must clear the anchor")
        assertTrue(
            events.any { it is SdkEvent.ReopenFailed },
            "forbidden during a re-establish must emit a one-shot ReopenFailed notice, events=$events",
        )
        collectJob.cancel()
    }
}
