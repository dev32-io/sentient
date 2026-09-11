// The client half of command binding (gateway spec §3.7). Ported from
// web-sdk's `command-binding.test.ts` per the web-sdk mirror contract.
//
// Wire-contract cases: what this stamps, and — the half that actually breaks
// things — what it must NOT stamp. A binding on the wrong frame does not
// degrade gracefully; the gateway refuses it and the message is gone.
package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

private val BINDING = CommandBinding(sessionId = "s_1", generation = 3)

private fun field(msg: ClientMessage, binding: CommandBinding?, key: String) =
    (stampCommandBinding(msg, binding) as JsonObject)[key]

class CommandBindingTest {

    @Test
    fun stamps_a_command_with_the_pair_the_gateway_announced() {
        val msg = ClientMessage.TextInput(text = "hi", pendingId = "p-1")
        assertEquals("s_1", field(msg, BINDING, "sessionId")?.jsonPrimitive?.content)
        assertEquals(3, field(msg, BINDING, "attachmentGeneration")?.jsonPrimitive?.content?.toInt())
        // The frame's own fields survive the merge.
        assertEquals("hi", field(msg, BINDING, "text")?.jsonPrimitive?.content)
    }

    @Test
    fun contract_conversation_activate_is_never_stamped() {
        // `conversation.activate` is how this client LEAVES a session. Binding
        // it to the session being left would make the gateway refuse the very
        // frame that switches, and switching would be unreachable.
        val msg = ClientMessage.ConversationActivate(sessionId = "s_2")
        assertNull(field(msg, BINDING, "attachmentGeneration"))
    }

    @Test
    fun contract_session_new_is_never_stamped() {
        val msg = ClientMessage.SessionNew(requestId = "r-1", intent = "explicit")
        assertNull(field(msg, BINDING, "attachmentGeneration"))
    }

    @Test
    fun invariant_a_draft_sends_its_minting_message_unstamped() {
        // A draft holds no attachment. `text.input` here is the frame that
        // mints the session; a stamp left over from the previous conversation
        // would be refused as stale and the new chat would never start.
        val msg = ClientMessage.TextInput(text = "hi")
        assertNull(field(msg, null, "sessionId"))
        assertNull(field(msg, null, "attachmentGeneration"))
    }

    @Test
    fun stamps_every_command_form_including_the_payload_less_ones() {
        // Payload-less interrupt and capture-bearing audio.end both receive binding.
        for (msg in listOf<ClientMessage>(ClientMessage.Interrupt, ClientMessage.AudioEnd("cap-1"))) {
            assertEquals("s_1", field(msg, BINDING, "sessionId")?.jsonPrimitive?.content)
        }
    }
}
