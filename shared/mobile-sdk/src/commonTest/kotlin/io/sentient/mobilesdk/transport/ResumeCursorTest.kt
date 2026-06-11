// ---------------------------------------------------------------------------
// ResumeCursorTest — wire-contract tests for seq dedup + epoch tracking.
//
// Ported from web-sdk's resume-cursor.test.ts. Pins the FSM/invariant: the
// cursor NEVER drops the first/fresh frame (lastSeq starts 0; seq 1 applied),
// drops replays (seq <= lastSeq), passes seq==0 through, and resets lastSeq on
// an epoch transition. Keeper per .claude/rules/testing.md (FSM invariant).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ResumeCursorTest {

    @Test
    fun starts_with_epoch_0_and_lastSeq_0() {
        val c = ResumeCursor()
        assertEquals(CursorSnapshot(epoch = 0, lastSeq = 0), c.snapshot)
    }

    @Test
    fun always_passes_through_seq0_frames() {
        val c = ResumeCursor()
        assertTrue(c.tryApply(0))
        assertTrue(c.tryApply(0))
        assertEquals(0L, c.snapshot.lastSeq)
    }

    @Test
    fun applies_the_first_seq_and_advances_lastSeq() {
        val c = ResumeCursor()
        assertTrue(c.tryApply(1))
        assertEquals(1L, c.snapshot.lastSeq)
    }

    @Test
    fun applies_seq_strictly_greater_than_lastSeq() {
        val c = ResumeCursor()
        c.tryApply(5)
        assertTrue(c.tryApply(6))
        assertEquals(6L, c.snapshot.lastSeq)
    }

    @Test
    fun drops_seq_equal_to_lastSeq() {
        val c = ResumeCursor()
        c.tryApply(3)
        assertFalse(c.tryApply(3))
        assertEquals(3L, c.snapshot.lastSeq)
    }

    @Test
    fun drops_seq_less_than_lastSeq() {
        val c = ResumeCursor()
        c.tryApply(10)
        assertFalse(c.tryApply(7))
        assertEquals(10L, c.snapshot.lastSeq)
    }

    @Test
    fun applies_seq_after_a_gap() {
        val c = ResumeCursor()
        c.tryApply(1)
        c.tryApply(2)
        assertTrue(c.tryApply(5))
        assertEquals(5L, c.snapshot.lastSeq)
    }

    @Test
    fun records_epoch_from_first_epoch_bearing_frame() {
        val c = ResumeCursor()
        c.tryApply(1, 42)
        assertEquals(42L, c.snapshot.epoch)
    }

    @Test
    fun epoch0_is_treated_as_absent() {
        val c = ResumeCursor()
        c.tryApply(5, 7)
        assertEquals(7L, c.snapshot.epoch)
        c.tryApply(6, 0)
        assertEquals(7L, c.snapshot.epoch)
        assertEquals(6L, c.snapshot.lastSeq)
    }

    @Test
    fun epoch_change_resets_lastSeq_and_applies_new_epoch_first_seq() {
        val c = ResumeCursor()
        c.tryApply(100, 1)
        assertTrue(c.tryApply(1, 2))
        assertEquals(2L, c.snapshot.epoch)
        assertEquals(1L, c.snapshot.lastSeq)
    }

    @Test
    fun same_epoch_dedup_still_works() {
        val c = ResumeCursor()
        c.tryApply(3, 5)
        assertFalse(c.tryApply(3, 5))
        assertTrue(c.tryApply(4, 5))
    }

    @Test
    fun reset_clears_both_epoch_and_lastSeq() {
        val c = ResumeCursor()
        c.tryApply(50, 9)
        c.reset()
        assertEquals(CursorSnapshot(epoch = 0, lastSeq = 0), c.snapshot)
    }

    @Test
    fun after_reset_first_seq_is_applied_again() {
        val c = ResumeCursor()
        c.tryApply(50, 9)
        c.reset()
        assertTrue(c.tryApply(1))
        assertEquals(1L, c.snapshot.lastSeq)
    }

    @Test
    fun reset_accepts_custom_epoch_and_lastSeq() {
        val c = ResumeCursor()
        c.reset(7, 99)
        assertEquals(CursorSnapshot(epoch = 7, lastSeq = 99), c.snapshot)
    }
}
