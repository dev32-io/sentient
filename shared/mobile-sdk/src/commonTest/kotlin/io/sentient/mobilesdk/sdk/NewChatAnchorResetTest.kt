// ---------------------------------------------------------------------------
// NewChatAnchorResetTest — pins the identity-axis invariant for "new chat".
//
// KEEPER (per .claude/rules/testing.md): FSM invariant + wire contract.
// The bug it guards: session.configure declares `conversationId = _currentSessionId`
// (SentientSdk), and the gateway re-anchors the session to it (resume.reanchor
// source="configure", ws-session-configure.ts). sendNewChat() cleared the history
// view + cognition but NOT the conversation anchor, so a configure during the
// pending mint (relaunch / reconnect) re-declared the OLD conversation → the next
// user.message landed in the previous chat and the fresh mint was abandoned (a
// phantom empty session). The fix: "+" drops the anchor ATOMICALLY; the mint's own
// session.created re-anchors to the NEW conversation.
//
// Drives the REAL orchestrator over a FakeWebSocketEngine under runTest virtual time.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.fakes.FakeWebSocketEngine
import io.sentient.mobilesdk.transport.WsIncoming
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class NewChatAnchorResetTest {

    private fun created(sessionId: String, ts: Long) =
        WsIncoming.Text("{\"type\":\"session.created\",\"sessionId\":\"$sessionId\",\"ts\":$ts}")

    @Test
    fun new_chat_clears_the_conversation_anchor_then_mint_reanchors() = runTest {
        val fake = FakeWebSocketEngine()
        val sdk = buildSdk(fake)
        connectToReady(sdk, fake)

        // A prior turn anchored an existing conversation.
        fake.emit(created("conv-old", 1))
        sdk.currentSessionId.first { it == "conv-old" }
        assertEquals("conv-old", sdk.currentSessionId.value, "precondition: anchored to the prior conversation")

        // "+" must drop the anchor ATOMICALLY — synchronously, before the async mint —
        // so a session.configure during the pending mint declares no conversationId.
        sdk.sendNewChat()
        assertEquals(null, sdk.currentSessionId.value, "new chat must clear the conversation anchor")
        runCurrent()
        assertEquals(null, sdk.currentSessionId.value, "anchor stays null while the mint is pending")

        // The fresh mint's session.created re-anchors to the NEW conversation only.
        fake.emit(created("conv-new", 2))
        sdk.currentSessionId.first { it == "conv-new" }
        assertEquals("conv-new", sdk.currentSessionId.value, "the mint re-anchors to the new conversation")
    }
}
