package io.sentient.mobilesdk.voice
import kotlin.test.Test
import kotlin.test.assertEquals

class MicStateTest {
    @Test fun frame_samples_is_20ms_at_16k() {
        assertEquals(320, FRAME_SAMPLES_16K) // 16000 * 0.020
    }
}
