package io.sentient.mobilesdk.dev

import kotlin.test.Test
import kotlin.test.assertEquals

class FaultHooksTest {
    @Test
    fun arming_expired_token_is_one_shot() {
        val h = FaultHooks()
        h.armExpiredToken()
        assertEquals(true, h.consumeExpiredToken())
        assertEquals(false, h.consumeExpiredToken())  // one-shot
    }

    @Test
    fun malformed_frame_is_one_shot() {
        val h = FaultHooks()
        assertEquals(false, h.consumeMalformedFrame())
        h.armMalformedFrame()
        assertEquals(true, h.consumeMalformedFrame())
        assertEquals(false, h.consumeMalformedFrame())
    }
}
