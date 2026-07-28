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
