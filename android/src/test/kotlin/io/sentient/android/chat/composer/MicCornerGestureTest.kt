package io.sentient.android.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * FSM invariants for the corner mic, mirroring the webui pin
 * (gateway/webui/src/components/dock/mic-corner-gesture.test.ts): hold→lock and
 * locked→release thresholds decide whether the mic stays on. A drifted threshold
 * silently turns push-to-talk into a stuck-open mic (or the reverse), so the
 * boundaries are pinned.
 */
class MicCornerGestureTest {

    private val travel = 100f

    // -- resolveRelease from a hold (origin IDLE) --

    @Test fun `returns idle when released below the lock threshold`() {
        assertEquals(ReleaseOutcome(MicCornerMode.IDLE, 0f), resolveRelease(MicCornerMode.IDLE, 39f, travel))
    }

    @Test fun `locks when released at the lock threshold`() {
        assertEquals(ReleaseOutcome(MicCornerMode.LOCKED, travel), resolveRelease(MicCornerMode.IDLE, 40f, travel))
    }

    @Test fun `locks when released past the lock threshold`() {
        assertEquals(ReleaseOutcome(MicCornerMode.LOCKED, travel), resolveRelease(MicCornerMode.IDLE, 80f, travel))
    }

    @Test fun `returns idle on a plain tap with no drag`() {
        assertEquals(ReleaseOutcome(MicCornerMode.IDLE, 0f), resolveRelease(MicCornerMode.IDLE, 0f, travel))
    }

    // -- resolveRelease from locked (origin LOCKED) --

    @Test fun `stays locked when barely dragged back`() {
        assertEquals(ReleaseOutcome(MicCornerMode.LOCKED, travel), resolveRelease(MicCornerMode.LOCKED, 80f, travel))
    }

    @Test fun `releases when dragged back to the unlock threshold`() {
        assertEquals(ReleaseOutcome(MicCornerMode.IDLE, 0f), resolveRelease(MicCornerMode.LOCKED, 50f, travel))
    }

    @Test fun `releases when dragged fully back`() {
        assertEquals(ReleaseOutcome(MicCornerMode.IDLE, 0f), resolveRelease(MicCornerMode.LOCKED, 0f, travel))
    }

    @Test fun `stays locked on a plain tap with no drag from the locked end`() {
        assertEquals(ReleaseOutcome(MicCornerMode.LOCKED, travel), resolveRelease(MicCornerMode.LOCKED, travel, travel))
    }

    // -- clampDrag --

    @Test fun `tracks leftward pointer movement from an idle origin`() {
        assertEquals(30f, clampDrag(0f, 200f, 170f, travel))
    }

    @Test fun `clamps to zero when dragging rightward past the origin`() {
        assertEquals(0f, clampDrag(0f, 200f, 260f, travel))
    }

    @Test fun `clamps to travel when dragging past the lock end`() {
        assertEquals(travel, clampDrag(0f, 200f, 40f, travel))
    }

    @Test fun `starts from the locked end when the origin is locked`() {
        assertEquals(70f, clampDrag(travel, 200f, 230f, travel))
    }

    // -- isArmed --

    @Test fun `does not arm below the lock threshold`() {
        assertFalse(isArmed(39f, travel))
    }

    @Test fun `arms exactly at the lock threshold`() {
        assertTrue(isArmed(40f, travel))
    }
}
