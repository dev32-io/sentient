package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals

// ---------------------------------------------------------------------------
// AudioPreRollRingTest — port of web-sdk audio-pre-roll-ring.test.ts FSM tests.
//
// Pins: idle buffering, ring trim, onset flush, active passthrough,
// hangover countdown, hangover re-arm, reset, zero-config pass-through gate.
//
// Only cases that pin real buffer/FSM behavior are kept (test-lean doctrine).
// Vacuous wiring tests (types, constants, DI) are omitted.
// ---------------------------------------------------------------------------

class AudioPreRollRingTest {

    // -----------------------------------------------------------------------
    // Seed cases (from plan)
    // -----------------------------------------------------------------------

    @Test
    fun onset_flushes_preroll_then_frame() {
        val r = AudioPreRollRing<Int>(preRollFrames = 2, hangoverFrames = 1)
        assertEquals(emptyList(), r.push(1, accepted = false))
        assertEquals(emptyList(), r.push(2, accepted = false))
        assertEquals(emptyList(), r.push(3, accepted = false)) // ring trims to [2,3]
        assertEquals(listOf(2, 3, 4), r.push(4, accepted = true))
    }

    @Test
    fun hangover_emits_then_idles() {
        val r = AudioPreRollRing<Int>(preRollFrames = 0, hangoverFrames = 1)
        assertEquals(listOf(10), r.push(10, accepted = true))
        assertEquals(listOf(11), r.push(11, accepted = false)) // hangover emits 1
        assertEquals(emptyList(), r.push(12, accepted = false)) // idle now
    }

    // -----------------------------------------------------------------------
    // Idle buffering — rejected frames are buffered silently
    // -----------------------------------------------------------------------

    @Test
    fun buffers_rejected_frames_silently_while_idle() {
        val r = AudioPreRollRing<Int>(preRollFrames = 3, hangoverFrames = 2)
        assertEquals(emptyList(), r.push(1, accepted = false))
        assertEquals(emptyList(), r.push(2, accepted = false))
        assertEquals(emptyList(), r.push(3, accepted = false))
        assertEquals(emptyList(), r.push(4, accepted = false))
    }

    // -----------------------------------------------------------------------
    // Ring trim — oldest frames are dropped when ring overflows
    // -----------------------------------------------------------------------

    @Test
    fun ring_trims_to_preroll_frames_dropping_oldest() {
        val r = AudioPreRollRing<Int>(preRollFrames = 2, hangoverFrames = 0)
        // push 3 rejected: ring should hold only last 2
        r.push(10, accepted = false) // dropped
        r.push(20, accepted = false) // kept
        r.push(30, accepted = false) // kept
        val out = r.push(40, accepted = true)
        assertEquals(listOf(20, 30, 40), out)
    }

    // -----------------------------------------------------------------------
    // Flush — onset emits the pre-roll ahead of the triggering accepted frame
    // -----------------------------------------------------------------------

    @Test
    fun flushes_buffered_preroll_ahead_of_first_accepted_frame() {
        val r = AudioPreRollRing<Int>(preRollFrames = 3, hangoverFrames = 2)
        r.push(1, accepted = false)
        r.push(2, accepted = false)
        r.push(3, accepted = false)
        val out = r.push(4, accepted = true)
        assertEquals(listOf(1, 2, 3, 4), out)
    }

    // -----------------------------------------------------------------------
    // Active passthrough — each accepted frame is emitted as-is while active
    // -----------------------------------------------------------------------

    @Test
    fun emits_each_accepted_frame_as_is_while_active() {
        val r = AudioPreRollRing<Int>(preRollFrames = 2, hangoverFrames = 2)
        r.push(1, accepted = true) // onset
        val out = r.push(2, accepted = true)
        assertEquals(listOf(2), out)
    }

    // -----------------------------------------------------------------------
    // Hangover — emits tail frames, then falls silent after counter exhausted
    // -----------------------------------------------------------------------

    @Test
    fun emits_hangover_frames_after_speech_ends_then_falls_silent() {
        val r = AudioPreRollRing<Int>(preRollFrames = 3, hangoverFrames = 2)
        r.push(1, accepted = true) // onset
        assertEquals(listOf(2), r.push(2, accepted = false)) // hangover 1/2
        assertEquals(listOf(3), r.push(3, accepted = false)) // hangover 2/2
        assertEquals(emptyList(), r.push(4, accepted = false)) // exhausted, buffered
    }

    // -----------------------------------------------------------------------
    // Hangover re-arm — accept during hangover resets the counter
    // -----------------------------------------------------------------------

    @Test
    fun rearms_hangover_counter_on_accept_during_hangover() {
        val r = AudioPreRollRing<Int>(preRollFrames = 3, hangoverFrames = 2)
        r.push(1, accepted = true) // onset
        assertEquals(1, r.push(2, accepted = false).size) // hangover 1/2 used
        r.push(3, accepted = true) // re-arm hangover to 2
        assertEquals(1, r.push(4, accepted = false).size) // hangover 1/2 used
        assertEquals(1, r.push(5, accepted = false).size) // hangover 2/2 used
        assertEquals(0, r.push(6, accepted = false).size) // exhausted
    }

    // -----------------------------------------------------------------------
    // Reset — clears ring and returns to idle
    // -----------------------------------------------------------------------

    @Test
    fun reset_clears_ring_and_returns_to_idle() {
        val r = AudioPreRollRing<Int>(preRollFrames = 2, hangoverFrames = 2)
        r.push(1, accepted = false)
        r.push(2, accepted = true) // active
        r.reset()
        // After reset, onset should flush empty pre-roll (ring was cleared)
        val out = r.push(3, accepted = true)
        assertEquals(listOf(3), out)
    }

    // -----------------------------------------------------------------------
    // Zero-config — preRollFrames=0, hangoverFrames=0 is a pass-through gate
    // -----------------------------------------------------------------------

    @Test
    fun zero_preroll_zero_hangover_behaves_as_pass_through_gate() {
        val r = AudioPreRollRing<Int>(preRollFrames = 0, hangoverFrames = 0)
        assertEquals(emptyList(), r.push(1, accepted = false))
        assertEquals(listOf(2), r.push(2, accepted = true))
        assertEquals(emptyList(), r.push(3, accepted = false))
    }
}
