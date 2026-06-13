package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VitalsRingTest {
    @Test fun appends_and_drains_in_order() {
        val r = VitalsRing(maxBytes = 1000)
        r.append("a")
        r.append("b")
        assertEquals("a\nb\n", r.drain())
        assertEquals("", r.drain()) // drained
    }

    @Test fun evicts_oldest_when_over_byte_cap() {
        val r = VitalsRing(maxBytes = 10) // tiny
        r.append("11111") // 6 bytes with \n
        r.append("22222") // would be 12 → evict oldest
        val out = r.drain()
        assertTrue(out.contains("22222"))
        assertTrue(!out.contains("11111"))
    }
}
