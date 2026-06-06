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

    @Test fun user_preferences_patch_nests_fields_under_payload() {
        val msg = ClientMessage.UserPreferencesPatch(
            payload = PreferencesPatchPayload(ttsEnabled = false),
        )
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        // Must have a nested payload object
        assertTrue(json.contains("\"payload\":{"), "expected nested payload object, got: $json")
        // ttsEnabled must live inside payload, not at the top level
        assertTrue(json.contains("\"ttsEnabled\":false"), "expected ttsEnabled in payload, got: $json")
        // ttsEnabled must NOT appear as a top-level key (i.e., only inside the payload braces)
        val payloadStart = json.indexOf("\"payload\":{")
        assertTrue(payloadStart >= 0, "payload key not found")
        val beforePayload = json.substring(0, payloadStart)
        assertTrue(!beforePayload.contains("\"ttsEnabled\""), "ttsEnabled must not appear before payload: $json")
    }

    @Test fun conversation_entry_assistant_with_cutoff() {
        val s = """{"type":"conversation.entry","item":{"ts":1,"kind":"assistant","content":"hello","cutoff":{"kind":"interrupt","cancelledTaskIds":["t1"]}}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.Assistant
        assertEquals("hello", item.content)
        assertEquals("interrupt", item.cutoff?.kind)
    }

    // Graceful degradation: a malformed feed item with a bad/missing ts must NEVER crash
    // WsTransport decode. coerceInputValues coerces explicit null to the UNKNOWN_TS default;
    // a missing key falls back to the default natively.

    @Test fun conversation_entry_with_null_ts_decodes_to_unknown_sentinel() {
        val s = """{"type":"conversation.entry","item":{"ts":null,"kind":"user","channel":"speech","content":"hi"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.User
        assertEquals(UNKNOWN_TS, item.ts)
        assertEquals("hi", item.content)
    }

    @Test fun conversation_entry_with_missing_ts_decodes_to_unknown_sentinel() {
        val s = """{"type":"conversation.entry","item":{"kind":"user","channel":"speech","content":"hi"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.User
        assertEquals(UNKNOWN_TS, item.ts)
        assertEquals("hi", item.content)
    }

    // ── pendingId on text.input ─────────────────────────────────────────────

    @Test fun text_input_with_pending_id_round_trips() {
        val msg: ClientMessage = ClientMessage.TextInput("hi", pendingId = "p1")
        val s = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        val back = WireJson.instance.decodeFromString(ClientMessage.serializer(), s) as ClientMessage.TextInput
        assertEquals("p1", back.pendingId)
        assertEquals("hi", back.text)
    }

    @Test fun text_input_without_pending_id_round_trips_null() {
        val msg: ClientMessage = ClientMessage.TextInput("hello")
        val s = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        val back = WireJson.instance.decodeFromString(ClientMessage.serializer(), s) as ClientMessage.TextInput
        assertEquals(null, back.pendingId)
        assertEquals("hello", back.text)
    }

    @Test fun conversation_entry_user_with_pending_id_decodes() {
        val s = """{"type":"conversation.entry","item":{"kind":"user","ts":1,"channel":"text","content":"hello","pendingId":"p1"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.User
        assertEquals("p1", item.pendingId)
        assertEquals("hello", item.content)
    }

    @Test fun conversation_entry_user_without_pending_id_decodes_null() {
        val s = """{"type":"conversation.entry","item":{"kind":"user","ts":1,"channel":"text","content":"hello"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.User
        assertEquals(null, item.pendingId)
        assertEquals("hello", item.content)
    }
}
