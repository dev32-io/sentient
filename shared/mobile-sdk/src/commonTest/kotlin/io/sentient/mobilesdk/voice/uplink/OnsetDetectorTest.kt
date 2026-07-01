package io.sentient.mobilesdk.voice.uplink

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OnsetDetectorTest {
    private fun loud(n: Int = 320) = ShortArray(n) { 8000 }
    private fun quiet(n: Int = 320) = ShortArray(n) { 0 }

    @Test fun fires_once_on_sustained_onset_edge() {
        val d = OnsetDetector(threshold = 0.05, sustainFrames = 2)
        assertFalse(d.observe(quiet()))
        assertFalse(d.observe(loud()))   // 1 loud — not yet sustained
        assertTrue(d.observe(loud()))    // 2 loud — onset edge fires
        assertFalse(d.observe(loud()))   // still speaking — no re-fire
    }

    @Test fun rearms_after_silence() {
        val d = OnsetDetector(threshold = 0.05, sustainFrames = 1)
        assertTrue(d.observe(loud()))
        assertFalse(d.observe(quiet()))
        assertTrue(d.observe(loud()))    // re-armed → fires again
    }
}
