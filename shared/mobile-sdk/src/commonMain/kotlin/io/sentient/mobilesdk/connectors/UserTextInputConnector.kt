// ---------------------------------------------------------------------------
// UserTextInputConnector — sends user text input to the gateway.
//
// Mirrors web-sdk's user-text-input-connector.ts VERBATIM:
//   capability = "text.input"  (input-only)
//   sendText(text) → emits the outbound text.input frame.
//
// web-sdk reaches the wire via sdk.send; mobile-sdk injects a `send` lambda so
// the orchestrator owns the transport. This connector receives NO inbound
// frames — handle() is a no-op for every type (it has nothing to observe), but
// it still implements [Connector] so the broadcast-and-filter router can fan
// every frame to it uniformly (MessageRouter).
//
// Threading: single-threaded; the orchestrator drives sendText on its own
// dispatcher. No internal mutable state.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage

class UserTextInputConnector(
    private val send: (ClientMessage) -> Unit,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "user-text-input")

    /** Send a text message to the gateway. Mirrors web-sdk sendText. */
    fun sendText(text: String) {
        log.info("send", mapOf("type" to "text.input", "len" to text.length))
        send(ClientMessage.TextInput(text))
    }

    /** Input-only connector: ignores every inbound frame. */
    override fun handle(msg: ServerMessage) {
        // No-op. This connector contributes only the outbound text.input frame;
        // it observes nothing on the inbound path. Required for the broadcast-
        // and-filter router (every frame reaches every connector).
    }

    companion object {
        const val CAPABILITY: String = "text.input"
    }
}
