package io.sentient.mobilesdk.protocol

import kotlin.test.Test
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
        val result = WireJson.decodeServerMessageResult("{\"type\":\"message.done\",\"cycleId\":\"c1\"}")
        assertTrue(result.isSuccess)
        assertTrue(result.getOrNull() is ServerMessage.MessageDone)
    }
}
