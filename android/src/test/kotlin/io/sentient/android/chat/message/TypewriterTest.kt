package io.sentient.android.chat.message

import kotlin.test.Test
import kotlin.test.assertEquals

class TypewriterTest {
    @Test fun revealsTowardTargetAtBaseRate() {
        val t = "hello world".toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 1.0, now = 0.0)
        assertEquals(t.size, s.visibleCount)
    }

    @Test fun clampsToMinAdvanceOne() {
        val t = "a".repeat(1000).toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 0.001, now = 0.0)
        assertEquals(1, s.visibleCount)
    }

    @Test fun drainsAtMaxRateWhenComplete() {
        val t = "a".repeat(100).toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = true, dt = 1.0, now = 0.0)
        assertEquals(100, s.visibleCount)
    }

    @Test fun holdsAfterSentenceBoundary() {
        val t = "Hi. More".toList()
        val s1 = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 0.12, now = 0.0)
        val after = s1.visibleCount
        val s2 = typewriterTick(s1, t, streamComplete = false, dt = 0.02, now = 0.01)
        assertEquals(after, s2.visibleCount)
    }

    @Test fun stopsExactlyAtSentenceBoundary() {
        val t = "Hi. More".toList()
        val s = typewriterTick(TypewriterState(), t, streamComplete = false, dt = 0.12, now = 0.0)
        assertEquals(3, s.visibleCount)
    }
}
