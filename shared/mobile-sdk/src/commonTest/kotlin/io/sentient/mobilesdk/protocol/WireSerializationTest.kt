package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WireSerializationTest {
    @Test fun auth_frame_encodes_with_type_discriminator() {
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), ClientMessage.Auth("tok123"))
        assertTrue(json.contains("\"type\":\"auth\""))
        assertTrue(json.contains("\"token\":\"tok123\""))
    }

    @Test fun text_input_round_trips() {
        val msg: ClientMessage = ClientMessage.TextInput("hi")
        val s = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        val back = WireJson.instance.decodeFromString(ClientMessage.serializer(), s)
        assertEquals(msg, back)
    }

    @Test fun session_ready_decodes_with_rates() {
        val s = """{"type":"session.ready","sessionId":"s1","audioEncoding":"pcm16","inputSampleRate":16000,"outputSampleRate":48000}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.SessionReady
        assertEquals("s1", msg.sessionId)
        assertEquals(16000, msg.inputSampleRate)
        assertEquals(48000, msg.outputSampleRate)
    }

    @Test fun unknown_server_type_decodes_to_unknown() {
        val s = """{"type":"some.future.frame","x":1}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s)
        assertTrue(msg is ServerMessage.Unknown)
    }

    @Test fun conversation_entry_assistant_with_cutoff() {
        val s = """{"type":"conversation.entry","item":{"ts":1,"kind":"assistant","content":"hello","cutoff":{"kind":"interrupt","cancelledTaskIds":["t1"]}}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.Assistant
        assertEquals("hello", item.content)
        assertEquals("interrupt", item.cutoff?.kind)
    }
}
