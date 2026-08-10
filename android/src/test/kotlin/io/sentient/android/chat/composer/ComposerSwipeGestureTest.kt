package io.sentient.android.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the swipe-to-dismiss accumulator's threshold + re-arm behavior. See
 * ComposerSwipeGesture.kt's doc comment, and the documented learning in
 * agents/docs/android/android-compose-details.md ("Nested drag races: raw
 * touch-slop, not angle dominance"), for the touch-slop race this
 * deferred-consumption design sidesteps — a drifted threshold here either
 * makes the keyboard-dismiss swipe feel laggy (too high) or resumes racing
 * the task strip's horizontalScroll for ambiguous drags (too low).
 */
class ComposerSwipeGestureTest {
    private val threshold = 24f

    @Test fun `accumulates without triggering below the threshold`() {
        assertEquals(SwipeAccumulation(10f, triggered = false), accumulateSwipeDown(0f, 10f, threshold))
    }

    @Test fun `does not trigger exactly at the threshold`() {
        assertEquals(SwipeAccumulation(24f, triggered = false), accumulateSwipeDown(0f, 24f, threshold))
    }

    @Test fun `triggers and resets just past the threshold`() {
        assertEquals(SwipeAccumulation(0f, triggered = true), accumulateSwipeDown(0f, 25f, threshold))
    }

    @Test fun `upward movement reduces the accumulator without triggering`() {
        assertEquals(SwipeAccumulation(-5f, triggered = false), accumulateSwipeDown(10f, -15f, threshold))
    }

    @Test fun `re-triggers on a second net descent past threshold within the same touch`() {
        val first = accumulateSwipeDown(0f, 25f, threshold)
        assertEquals(SwipeAccumulation(0f, triggered = true), first)
        val second = accumulateSwipeDown(first.netPx, 25f, threshold)
        assertEquals(SwipeAccumulation(0f, triggered = true), second)
    }
}
