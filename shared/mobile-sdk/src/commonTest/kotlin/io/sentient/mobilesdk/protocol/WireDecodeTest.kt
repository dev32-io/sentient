package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertTrue

class WireDecodeTest {
    @Test
    fun malformed_json_returns_decode_failure() {
        val result = WireJson.decodeServerMessageResult("{ not valid json ")
        assertTrue(result.isFailure)
    }
}
