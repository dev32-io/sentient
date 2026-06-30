package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeMicSourceTest {
    @Test
    fun emits_frames_and_state() = runTest {
        val mic = FakeMicSource()
        mic.start()
        assertEquals(MicState.Live, mic.state.value)
        mic.emit(shortArrayOf(1, 2, 3))
        assertEquals(listOf<Short>(1, 2, 3), mic.frames.first().toList())
    }
}
