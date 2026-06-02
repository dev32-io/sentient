package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// EchoGateTest — port of web-sdk echo-gate.ts FSM tests.
//
// Pins: state-machine transitions (baseline/playback/tail), threshold
// semantics, injected-clock tail expiry, cancel → baseline return.
//
// Clock deviation: web-sdk uses an injected timer callback for tail hold.
// KMP port replaces the timer with an injected `nowMs` parameter on
// `onPlaybackDrain(cycleId, nowMs)` / `state(nowMs)` / `acceptFrame(pcm, nowMs)`.
// Semantics are identical; the design is deterministic and testable with no
// real clock.
// ---------------------------------------------------------------------------

class EchoGateTest {

    private val cfg = EchoGateConfig(
        baselineThreshold = 0.03,
        playbackThreshold = 0.2,
        tailHoldMs = 800
    )

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** 64-sample frame where every sample is [value]. */
    private fun frame(value: Short): ShortArray = ShortArray(64) { value }

    // -----------------------------------------------------------------------
    // BASELINE state
    // -----------------------------------------------------------------------

    @Test
    fun baseline_accepts_above_baseline_threshold() {
        val g = EchoGate(cfg)
        // rms(ShortArray(64) { 4000 }) = 4000/32768 ≈ 0.122 > baselineThreshold(0.03)
        val loud = ShortArray(64) { 4000 }
        assertTrue(g.acceptFrame(loud, nowMs = 0))
    }

    @Test
    fun baseline_rejects_below_baseline_threshold() {
        val g = EchoGate(cfg)
        // rms(ShortArray(64) { 500 }) = 500/32768 ≈ 0.015 < baselineThreshold(0.03)
        val quiet = ShortArray(64) { 500 }
        assertFalse(g.acceptFrame(quiet, nowMs = 0))
    }

    @Test
    fun empty_frame_rejected() {
        val g = EchoGate(cfg)
        assertFalse(g.acceptFrame(ShortArray(0), nowMs = 0))
    }

    @Test
    fun initial_state_is_baseline() {
        val g = EchoGate(cfg)
        assertEquals(EchoGateState.BASELINE, g.state(nowMs = 0))
    }

    // -----------------------------------------------------------------------
    // PLAYBACK state
    // -----------------------------------------------------------------------

    @Test
    fun playback_raises_threshold() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        // rms ≈ 0.061 — passes baseline(0.03) but fails playback(0.2)
        val mid = ShortArray(64) { 2000 }
        assertFalse(g.acceptFrame(mid, nowMs = 10))
    }

    @Test
    fun playback_accepts_loud_barge_in() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        // rms ≈ 0.305 — exceeds playback(0.2)
        val loud = ShortArray(64) { 10000 }
        assertTrue(g.acceptFrame(loud, nowMs = 10))
    }

    @Test
    fun onPlaybackStart_transitions_to_playback_state() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        assertEquals(EchoGateState.PLAYBACK, g.state(nowMs = 0))
    }

    // -----------------------------------------------------------------------
    // TAIL state
    // -----------------------------------------------------------------------

    @Test
    fun tail_holds_then_returns_to_baseline() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 100)
        // rms ≈ 0.061 — below playback threshold (tail uses playbackThreshold)
        val mid = ShortArray(64) { 2000 }
        assertFalse(g.acceptFrame(mid, nowMs = 200))    // still in tail: 200 < 100+800
        assertTrue(g.acceptFrame(mid, nowMs = 1000))    // tail expired → baseline: 0.061 > 0.03
    }

    @Test
    fun tail_expiry_at_exact_boundary() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        val mid = ShortArray(64) { 2000 }
        // At exactly tailExpiresAtMs (0+800=800) the tail has expired
        assertTrue(g.acceptFrame(mid, nowMs = 800))
    }

    @Test
    fun tail_state_reported_before_expiry() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        assertEquals(EchoGateState.TAIL, g.state(nowMs = 799))
    }

    @Test
    fun state_returns_baseline_after_tail_expiry() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        assertEquals(EchoGateState.BASELINE, g.state(nowMs = 800))
    }

    @Test
    fun drain_ignored_when_not_in_playback() {
        val g = EchoGate(cfg)
        // drain without start — should stay baseline, no tail started
        g.onPlaybackDrain("c1", nowMs = 0)
        assertEquals(EchoGateState.BASELINE, g.state(nowMs = 100))
    }

    // -----------------------------------------------------------------------
    // CANCEL — return to baseline
    // -----------------------------------------------------------------------

    @Test
    fun cancel_returns_to_baseline_immediately() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackCancel("c1")
        assertEquals(EchoGateState.BASELINE, g.state(nowMs = 5))
    }

    @Test
    fun cancel_during_tail_clears_tail_immediately() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        g.onPlaybackCancel("c1")
        // After cancel, a mid frame should pass (baseline threshold)
        val mid = ShortArray(64) { 2000 }
        assertTrue(g.acceptFrame(mid, nowMs = 50))
    }

    // -----------------------------------------------------------------------
    // TAIL → PLAYBACK re-entry
    // -----------------------------------------------------------------------

    @Test
    fun new_playback_during_tail_enters_playback_state() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        // New reply starts before tail expires
        g.onPlaybackStart("c2")
        assertEquals(EchoGateState.PLAYBACK, g.state(nowMs = 100))
    }

    @Test
    fun drain_of_new_cycle_during_tail_resets_tail_timer() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        g.onPlaybackDrain("c1", nowMs = 0)
        g.onPlaybackStart("c2")
        // Drain c2 at t=500 — new tail expires at 500+800=1300
        g.onPlaybackDrain("c2", nowMs = 500)
        val mid = ShortArray(64) { 2000 }
        assertFalse(g.acceptFrame(mid, nowMs = 1000))   // still in tail
        assertTrue(g.acceptFrame(mid, nowMs = 1300))    // expired → baseline
    }
}
