package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WireDecodeTest {
    @Test
    fun malformed_json_returns_decode_failure() {
        val result = WireJson.decodeServerMessageResult("{ not valid json ")
        assertTrue(result.isFailure)
    }

    @Test
    fun unknown_but_valid_frame_decodes_to_unknown_success() {
        val result = WireJson.decodeServerMessageResult("{\"type\":\"totally.unknown.frame\"}")
        assertTrue(result.isSuccess)
        assertTrue(result.getOrNull() is ServerMessage.Unknown)
    }

    @Test
    fun known_frame_decodes_to_typed_success() {
        val result = WireJson.decodeServerMessageResult("{\"type\":\"turn.completed\",\"turnId\":\"t1\"}")
        assertTrue(result.isSuccess)
        assertTrue(result.getOrNull() is ServerMessage.TurnCompleted)
    }

    /**
     * A RETIRED feed-item kind must not take the whole frame down with it.
     *
     * `kind:"tool"` was deleted from the feed in the 2.0 reply-fold wave, and OTA
     * means a staged rollout routinely puts a new phone in front of an older gateway
     * that still sends it. Without a polymorphic default for ConversationFeedItem the
     * unknown discriminator throws, `conversation.snapshot` is dropped whole, and the
     * user sees a BLANK chat rather than one row short.
     */
    @Test
    fun snapshot_with_a_retired_item_kind_keeps_every_other_row() {
        val raw = """
            {"type":"conversation.snapshot","items":[
              {"kind":"user","entryId":"e1","ts":1,"channel":"text","content":"hi"},
              {"kind":"tool","entryId":"e2","ts":2,"toolName":"search_web","status":"done"},
              {"kind":"assistant","entryId":"e3","ts":3,"content":"hello"}
            ]}
        """.trimIndent()

        val result = WireJson.decodeServerMessageResult(raw)

        assertTrue(result.isSuccess, "a retired item kind dropped the whole snapshot frame")
        val msg = result.getOrNull()
        assertTrue(msg is ServerMessage.ConversationSnapshot)
        assertEquals(3, msg.items.size)
        assertTrue(msg.items[1] is ConversationFeedItem.Unknown)
        assertEquals("hi", (msg.items[0] as ConversationFeedItem.User).content)
        assertEquals("hello", (msg.items[2] as ConversationFeedItem.Assistant).content)
    }

    @Test
    fun a_single_entry_of_a_retired_kind_decodes_instead_of_throwing() {
        val raw = """{"type":"conversation.entry","item":{"kind":"tool","entryId":"e2","ts":2,"toolName":"x"}}"""

        val result = WireJson.decodeServerMessageResult(raw)

        assertTrue(result.isSuccess)
        val msg = result.getOrNull()
        assertTrue(msg is ServerMessage.ConversationEntry)
        assertTrue(msg.item is ConversationFeedItem.Unknown)
    }

    // sessions.error WITHOUT requestId — emitted by the gateway on conversation.activate
    // failure. A missing required field previously caused MissingFieldException and the
    // frame was dropped. requestId is now optional (String? = null).
    @Test
    fun sessions_error_without_requestId_decodes_successfully() {
        val raw = "{\"type\":\"sessions.error\",\"code\":\"forbidden\",\"message\":\"not your session\"}"
        val result = WireJson.decodeServerMessageResult(raw)
        assertTrue(result.isSuccess)
        val msg = result.getOrNull()
        assertTrue(msg is ServerMessage.SessionsError)
        assertNull(msg.requestId)
        assertEquals("forbidden", msg.code)
        assertEquals("not your session", msg.message)
    }
}
