package io.sentient.mobilesdk.voice.uplink
import kotlin.test.Test
import kotlin.test.assertEquals

class FramerTest {
    @Test fun slices_exact_frames_and_carries_remainder() {
        val f = Framer(frameSamples = 4)
        assertEquals(0, f.push(shortArrayOf(1, 2, 3)).size)        // buffered, no full frame
        val out = f.push(shortArrayOf(4, 5, 6, 7, 8))              // total 8 → two frames of 4
        assertEquals(2, out.size)
        assertEquals(listOf<Short>(1,2,3,4), out[0].toList())
        assertEquals(listOf<Short>(5,6,7,8), out[1].toList())
    }
    @Test fun reset_drops_remainder() {
        val f = Framer(frameSamples = 4)
        f.push(shortArrayOf(1, 2))
        f.reset()
        assertEquals(0, f.push(shortArrayOf(3, 4)).size) // remainder gone → only 2 buffered
    }
}
