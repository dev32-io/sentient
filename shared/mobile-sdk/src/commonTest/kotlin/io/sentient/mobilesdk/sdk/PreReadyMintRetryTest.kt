// ---------------------------------------------------------------------------
// PreReadyMintRetryTest — pins the pre-READY mint retry path (A2 recovery).
//
// KEEPER (per .claude/rules/testing.md): FSM invariant + wire contract.
// The bug it guards: sendNewChat() fires before the socket is open; the
// session.new frame is dropped (null activeTransport → sendControl.dropped
// WARN). On the first-connect READY rising edge the SDK must detect the
// pending mint and re-send session.new so the gateway can mint the session.
//
// Without the retry the user taps "New Chat" and nothing happens — no
// session.created, no UI update. With it the frame lands after READY and the
// gateway echoes session.created normally.
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest
// virtual time. The session.new frame capture uses `fake.sentText` on the
// current session (the one opened by connect()).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PreReadyMintRetryTest {

    private fun newChatFrames(sent: List<String>) =
        sent.filter { it.contains("\"type\":\"session.new\"") }

    @Test
    fun send_new_chat_before_ready_retries_on_first_connect_ready() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)

        // Fire sendNewChat() BEFORE the socket is open (DISCONNECTED).
        // The session.new frame is silently dropped — no active transport.
        assertEquals(SdkStatus.DISCONNECTED, sdk.connection.value.status, "precondition: DISCONNECTED before connect")
        sdk.sendNewChat()

        // No frame should have been sent yet — there is no transport.
        // (The session.new may have been launched onto the scope but the transport
        // is null; after runCurrent it resolves to a sendControl.dropped WARN.)
        runCurrent()
        // At this point the frame was dropped (transport was null). We don't
        // assert sentText.isEmpty() here because the FakeWebSocketEngine does not
        // exist yet (no open() was called). We drive connect and verify the retry fires.

        // Now connect — on the first-connect READY rising edge the SDK must detect
        // hasPendingMint()==true and call retryPendingMint(), which re-sends session.new.
        val job = launch { sdk.connect() }
        connectToReady(sdk, fake)
        job.join()
        runCurrent()

        // The CURRENT session (opened by connect()) must contain exactly one session.new —
        // the retry that fired on the READY edge. The original dropped frame never reached
        // the wire (transport was null), so only the retry is on the wire.
        val newChats = newChatFrames(fake.sentText)
        assertTrue(
            newChats.isNotEmpty(),
            "session.new must be retried on first-connect READY after a pre-READY sendNewChat, sent=${fake.sentText}",
        )
        assertEquals(
            1,
            newChats.size,
            "exactly one session.new must be sent (retry only, no double-mint), sent=${fake.sentText}",
        )
    }

    @Test
    fun send_new_chat_after_ready_sends_immediately_no_retry() = runTest {
        // Sanity check: if sendNewChat() is called AFTER READY the normal path fires
        // immediately and the READY retry branch is not involved (hasPendingMint starts
        // false because sendNew clears lastMintAtMs when session.created arrives, but
        // here we just verify the frame reaches the wire without a second copy).
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)
        runCurrent()

        val framesBefore = fake.sentText.size
        sdk.sendNewChat()
        runCurrent()

        val newChats = newChatFrames(fake.sentText.drop(framesBefore))
        assertEquals(
            1,
            newChats.size,
            "sendNewChat after READY must send exactly one session.new immediately, sent=${fake.sentText}",
        )
    }
}
