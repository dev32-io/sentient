package io.sentient.mobilesdk.voice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MicStateTest {
    @Test fun frame_samples_is_20ms_at_16k() {
        assertEquals(320, FRAME_SAMPLES_16K) // 16000 * 0.020
    }
    @Test fun error_carries_reason() {
        val s: MicState = MicState.Error("engine-start-failed")
        assertTrue(s is MicState.Error && s.reason == "engine-start-failed")
    }
}
