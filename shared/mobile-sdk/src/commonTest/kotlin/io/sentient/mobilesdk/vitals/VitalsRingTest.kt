package io.sentient.mobilesdk.vitals

import kotlin.test.Test
import kotlin.test.assertEquals

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
        assertEquals("22222\n", out)
    }

    @Test fun drops_a_single_line_larger_than_cap() {
        val r = VitalsRing(maxBytes = 10)
        r.append("x".repeat(50)) // 51 bytes, alone exceeds cap
        assertEquals("", r.drain())
    }

    @Test fun keeps_buffer_bounded_across_repeated_oversized_appends() {
        val r = VitalsRing(maxBytes = 10)
        repeat(5) { r.append("y".repeat(50)) }
        assertEquals("", r.drain()) // never accumulates
    }
}
