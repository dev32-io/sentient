package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    @Test fun text_input_null_pending_id_omits_key_in_json() {
        // Wire contract: null pendingId MUST be omitted from the JSON (not encoded as "pendingId":null)
        // because the gateway validates with z.string().optional(), which accepts ABSENT key but
        // would REJECT explicit null. explicitNulls=false should enforce this.
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), ClientMessage.TextInput(text = "hi"))
        assertFalse(
            json.contains("pendingId"),
            "null pendingId must be omitted from the wire frame (gateway zod is .optional(), not .nullable()); got: $json"
        )

        // Positive assertion: pendingId IS included when non-null
        val jsonWithId = WireJson.instance.encodeToString(ClientMessage.serializer(), ClientMessage.TextInput(text = "hi", pendingId = "p1"))
        assertTrue(
            jsonWithId.contains("\"pendingId\":\"p1\""),
            "non-null pendingId must be present in the wire frame; got: $jsonWithId"
        )
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

    // ── Task 3.10: deviceId + resume handshake + entryId ──

    @Test fun session_configure_carries_device_id() {
        val msg = ClientMessage.SessionConfigure(
            capabilities = Capabilities(listOf("text.input", "stream.resume")),
            clientType = "mobile",
            deviceId = "dev-abc",
        )
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        assertTrue(json.contains("\"type\":\"session.configure\""), json)
        assertTrue(json.contains("\"deviceId\":\"dev-abc\""), json)
        assertTrue(json.contains("\"clientType\":\"mobile\""), json)
        // Fresh connect: no resume object on the wire (explicitNulls=false).
        assertTrue(!json.contains("\"resume\""), json)
    }

    @Test fun session_configure_carries_resume_on_reconnect() {
        val msg: ClientMessage = ClientMessage.SessionConfigure(
            capabilities = Capabilities(listOf("text.input", "stream.resume")),
            clientType = "mobile",
            deviceId = "dev-xyz",
            resume = ResumeParams(epoch = 3, lastSeq = 42),
        )
        val s = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        assertTrue(s.contains("\"type\":\"session.configure\""), s)
        assertTrue(s.contains("\"resume\":{\"epoch\":3,\"lastSeq\":42}"), s)
        val back = WireJson.instance.decodeFromString(ClientMessage.serializer(), s)
        assertEquals(msg, back)
    }

    @Test fun stream_resumed_recovered_decodes_with_range() {
        val s = """{"type":"stream.resumed","recovered":true,"epoch":3,"fromSeq":10,"toSeq":20}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.StreamResumed
        assertTrue(msg.recovered)
        assertEquals(3L, msg.epoch)
        assertEquals(10L, msg.fromSeq)
        assertEquals(20L, msg.toSeq)
    }

    @Test fun stream_resumed_not_recovered_decodes_without_range() {
        val s = """{"type":"stream.resumed","recovered":false,"epoch":4}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.StreamResumed
        assertFalse(msg.recovered)
        assertEquals(4L, msg.epoch)
        assertEquals(null, msg.fromSeq)
    }

    @Test fun stream_resumed_tolerates_seq_stamp_from_frame_sequencer() {
        // The gateway FrameSequencer stamps seq/epoch on the way out; the extra
        // top-level seq must not break decode (ignoreUnknownKeys).
        val s = """{"type":"stream.resumed","recovered":true,"epoch":2,"fromSeq":1,"toSeq":5,"seq":99}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.StreamResumed
        assertTrue(msg.recovered)
    }

    @Test fun conversation_entry_reads_entry_id_from_wire() {
        val s = """{"type":"conversation.entry","item":{"kind":"assistant","entryId":"e-7","ts":1,"content":"hi"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.Assistant
        assertEquals("e-7", item.entryId)
    }

    @Test fun conversation_entry_without_entry_id_degrades_to_default() {
        // Legacy / malformed frame without entryId still decodes (defense-in-depth).
        val s = """{"type":"conversation.entry","item":{"kind":"user","ts":1,"channel":"text","content":"hi"}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.User
        assertEquals(UNKNOWN_ENTRY_ID, item.entryId)
    }

    @Test fun gateway_push_frame_seq_epoch_are_peelable() {
        // The SDK reads seq/epoch generically off the raw JSON (not per-variant).
        val s = """{"type":"message.delta","cycleId":"c1","delta":"hi","seq":7,"epoch":2}"""
        val (seq, epoch) = WireJson.peelSeqEpoch(s)
        assertEquals(7L, seq)
        assertEquals(2L, epoch)
    }

    @Test fun frame_without_seq_epoch_peels_to_zero_and_null() {
        val (seq, epoch) = WireJson.peelSeqEpoch("""{"type":"pong"}""")
        assertEquals(0L, seq)
        assertEquals(null, epoch)
    }
}
