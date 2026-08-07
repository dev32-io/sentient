package io.sentient.mobilesdk.protocol

import io.sentient.mobilesdk.result.SentientError
import kotlin.test.Test
import kotlin.test.assertEquals

class SdkEventTest {
    @Test
    fun delta_carries_turn_and_chunk() {
        val e = SdkEvent.MessageDelta(turnId = "c1", chunk = "hel")
        assertEquals("c1", e.turnId)
        assertEquals("hel", e.chunk)
    }

    @Test
    fun protocolError_wraps_sentientError() {
        val e = SdkEvent.ProtocolError(SentientError.Protocol("bad frame"))
        assertEquals("bad frame", e.error.userMessage)
    }
}
