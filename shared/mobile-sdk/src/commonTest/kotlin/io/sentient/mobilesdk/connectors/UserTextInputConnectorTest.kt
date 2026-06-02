// ---------------------------------------------------------------------------
// UserTextInputConnectorTest — ported VERBATIM from web-sdk
// user-text-input-connector.test.ts. Wire/protocol contract at the
// gateway↔SDK boundary (the outbound text.input frame) → keeper per
// .claude/rules/testing.md.
//
// web-sdk surfaces send via sdk.send; mobile-sdk injects a `send` lambda. The
// attach/detach lifecycle becomes constructor-injection (the orchestrator owns
// connector lifetime in Kotlin), so the TS "does not send after detach" case
// has no analogue — there is no nullable sdk to clear.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ClientMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class UserTextInputConnectorTest {

    private fun recorder(): Pair<MutableList<ClientMessage>, (ClientMessage) -> Unit> {
        val sent = mutableListOf<ClientMessage>()
        return sent to { msg -> sent += msg }
    }

    @Test
    fun has_capability_text_input() {
        val (_, send) = recorder()
        assertEquals("text.input", UserTextInputConnector(send).capability)
    }

    @Test
    fun sendText_sends_text_input_message_via_send_lambda() {
        val (sent, send) = recorder()
        val connector = UserTextInputConnector(send)

        connector.sendText("hello")

        assertEquals(listOf<ClientMessage>(ClientMessage.TextInput("hello")), sent)
    }

    @Test
    fun handle_ignores_inbound_frames() {
        val (sent, send) = recorder()
        val connector = UserTextInputConnector(send)

        // This is an input-only connector; broadcast frames are no-ops.
        connector.handle(io.sentient.mobilesdk.protocol.ServerMessage.Pong)

        assertEquals(emptyList<ClientMessage>(), sent)
    }
}
