package io.sentient.mobilesdk.presence

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// ---------------------------------------------------------------------------
// IdleDetectorTest — port of web-sdk presence/idle-detector.test.ts.
//
// Pins: FSM invariant (active→warning→idle by elapsed time), suppression-clamp
// logic (cycleActive / ttsActive / demandStay block idle → warning),
// event resets (all event kinds re-anchor the timer), demand-stay
// acquire/release counter, 30_000 floor + 0.9 warning-fraction math.
//
// All time is injected (nowMs: Long); no real clock.
// ---------------------------------------------------------------------------

// A one-hour threshold is too long for snappy tests. Use a tight synthetic
// threshold (above the 30 s floor). warningThresholdMs defaults to 90% of
// idleThresholdMs (i.e. 60_000 * 0.9 = 54_000).
private const val BASE_IDLE_MS = 60_000L
private const val BASE_WARNING_MS = (BASE_IDLE_MS * DEFAULT_WARNING_FRACTION).toLong() // 54_000

private fun baseDetector(): IdleDetector =
    createIdleDetector(IdleDetectorConfig(idleThresholdMs = BASE_IDLE_MS))

class IdleDetectorConfigValidationTest {

    @Test
    fun rejects_idleThresholdMs_below_30s_floor() {
        assertFails {
            createIdleDetector(IdleDetectorConfig(idleThresholdMs = MINIMUM_IDLE_THRESHOLD_MS - 1))
        }
    }

    @Test
    fun accepts_idleThresholdMs_at_exactly_30s_floor() {
        // Should not throw.
        createIdleDetector(IdleDetectorConfig(idleThresholdMs = MINIMUM_IDLE_THRESHOLD_MS))
    }

    @Test
    fun rejects_warningThresholdMs_equal_to_idleThresholdMs() {
        assertFails {
            createIdleDetector(
                IdleDetectorConfig(idleThresholdMs = 60_000, warningThresholdMs = 60_000)
            )
        }
    }

    @Test
    fun rejects_warningThresholdMs_above_idleThresholdMs() {
        assertFails {
            createIdleDetector(
                IdleDetectorConfig(idleThresholdMs = 60_000, warningThresholdMs = 61_000)
            )
        }
    }

    @Test
    fun rejects_negative_warningThresholdMs() {
        assertFails {
            createIdleDetector(
                IdleDetectorConfig(idleThresholdMs = 60_000, warningThresholdMs = -1)
            )
        }
    }
}

class IdleDetectorInitialStateTest {

    @Test
    fun starts_in_active_state() {
        assertEquals(IdleDetectorState.ACTIVE, baseDetector().snapshot().state)
    }

    @Test
    fun exposes_configured_thresholds_in_snapshot() {
        val det = baseDetector()
        val snap = det.snapshot()
        assertEquals(BASE_IDLE_MS, snap.idleThresholdMs)
        assertEquals(BASE_WARNING_MS, snap.warningThresholdMs)
    }

    @Test
    fun starts_with_all_suppression_flags_cleared() {
        val snap = baseDetector().snapshot()
        assertFalse(snap.cycleActive)
        assertFalse(snap.ttsActive)
        assertEquals(0, snap.demandStayCount)
    }
}

class IdleDetectorTickTransitionsTest {

    @Test
    fun stays_active_before_warning_threshold() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_WARNING_MS - 1))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
    }

    @Test
    fun transitions_active_to_warning_at_warning_threshold() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_WARNING_MS))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun stays_warning_until_idle_threshold() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS - 1))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun transitions_warning_to_idle_at_idle_threshold() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }

    @Test
    fun skips_warning_when_single_tick_passes_idle_threshold_directly() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 1_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }

    @Test
    fun stays_idle_on_further_ticks() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS * 2))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }
}

class IdleDetectorEventResetsTest {

    private fun verifyResetsFromWarning(event: IdleDetectorEvent) {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_WARNING_MS))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        det.handle(event)
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
    }

    private fun verifyResetsFromIdle(event: IdleDetectorEvent) {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
        det.handle(event)
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
    }

    @Test
    fun interaction_resets_from_warning() {
        verifyResetsFromWarning(IdleDetectorEvent.Interaction(BASE_WARNING_MS))
    }

    @Test
    fun interaction_resets_from_idle() {
        verifyResetsFromIdle(IdleDetectorEvent.Interaction(BASE_IDLE_MS))
    }

    @Test
    fun cycle_start_resets_from_warning() {
        verifyResetsFromWarning(IdleDetectorEvent.CycleStart(BASE_WARNING_MS))
    }

    @Test
    fun cycle_start_resets_from_idle() {
        verifyResetsFromIdle(IdleDetectorEvent.CycleStart(BASE_IDLE_MS))
    }

    @Test
    fun cycle_end_resets_from_warning() {
        verifyResetsFromWarning(IdleDetectorEvent.CycleEnd(BASE_WARNING_MS))
    }

    @Test
    fun cycle_end_resets_from_idle() {
        verifyResetsFromIdle(IdleDetectorEvent.CycleEnd(BASE_IDLE_MS))
    }

    @Test
    fun tts_start_resets_from_warning() {
        verifyResetsFromWarning(IdleDetectorEvent.TtsStart(BASE_WARNING_MS))
    }

    @Test
    fun tts_start_resets_from_idle() {
        verifyResetsFromIdle(IdleDetectorEvent.TtsStart(BASE_IDLE_MS))
    }

    @Test
    fun tts_end_resets_from_warning() {
        verifyResetsFromWarning(IdleDetectorEvent.TtsEnd(BASE_WARNING_MS))
    }

    @Test
    fun tts_end_resets_from_idle() {
        verifyResetsFromIdle(IdleDetectorEvent.TtsEnd(BASE_IDLE_MS))
    }

    @Test
    fun multiple_events_in_sequence_re_anchor_timer_each_time() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Interaction(5_000))
        det.handle(IdleDetectorEvent.TtsEnd(20_000))
        det.handle(IdleDetectorEvent.CycleEnd(40_000))
        // anchor=40_000; warning at 40_000+54_000=94_000 → active at 90_000
        det.handle(IdleDetectorEvent.Tick(90_000))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
        // warning at 94_000
        det.handle(IdleDetectorEvent.Tick(94_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        // idle at 40_000+60_000=100_000
        det.handle(IdleDetectorEvent.Tick(100_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }

    @Test
    fun event_re_anchors_timer_idle_no_longer_fires_at_previous_boundary() {
        val det = baseDetector()
        // Reset at t=10s; idle should fire at 10_000+60_000=70_000, not 60_000.
        det.handle(IdleDetectorEvent.Interaction(10_000))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
        assertEquals(10_000L, det.snapshot().lastResetAtMs)
    }
}

class IdleDetectorCycleSuppressionTest {

    @Test
    fun sets_cycleActive_on_cycle_start_and_clears_on_cycle_end() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        assertTrue(det.snapshot().cycleActive)
        det.handle(IdleDetectorEvent.CycleEnd(1_000))
        assertFalse(det.snapshot().cycleActive)
    }

    @Test
    fun blocks_idle_transition_while_cycleActive() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 30_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun resumes_idle_after_cycle_end_clears_flag() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 10_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        det.handle(IdleDetectorEvent.CycleEnd(100_000))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
        det.handle(IdleDetectorEvent.Tick(160_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }
}

class IdleDetectorTtsSuppressionTest {

    @Test
    fun sets_ttsActive_on_tts_start_and_clears_on_tts_end() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.TtsStart(0))
        assertTrue(det.snapshot().ttsActive)
        det.handle(IdleDetectorEvent.TtsEnd(1_000))
        assertFalse(det.snapshot().ttsActive)
    }

    @Test
    fun blocks_idle_transition_while_ttsActive() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.TtsStart(0))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 30_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun resumes_idle_after_tts_end_clears_flag() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.TtsStart(0))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 10_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        det.handle(IdleDetectorEvent.TtsEnd(100_000))
        det.handle(IdleDetectorEvent.Tick(160_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }
}

class IdleDetectorIndependentFlagsTest {

    @Test
    fun still_blocks_idle_while_only_ttsActive_is_set_cycle_cleared_first() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.TtsStart(0))
        det.handle(IdleDetectorEvent.CycleEnd(10_000))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 30_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun still_blocks_idle_while_only_cycleActive_is_set_tts_cleared_first() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.TtsStart(0))
        det.handle(IdleDetectorEvent.TtsEnd(10_000))
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 30_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun resumes_idle_only_after_both_flags_clear() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.TtsStart(0))
        det.handle(IdleDetectorEvent.TtsEnd(10_000))
        det.handle(IdleDetectorEvent.CycleEnd(20_000))
        det.handle(IdleDetectorEvent.Tick(20_000 + BASE_IDLE_MS))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }
}

class IdleDetectorDemandStayTest {

    @Test
    fun increments_demandStayCount_on_acquire_and_decrements_on_release() {
        val det = baseDetector()
        val rel = det.acquireDemandStay()
        assertEquals(1, det.snapshot().demandStayCount)
        rel()
        assertEquals(0, det.snapshot().demandStayCount)
    }

    @Test
    fun blocks_idle_transition_while_any_demand_is_held() {
        val det = baseDetector()
        det.acquireDemandStay()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 30_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun resumes_idle_after_last_demand_released() {
        val det = baseDetector()
        val rel = det.acquireDemandStay()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 10_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        rel()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 20_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }

    @Test
    fun requires_every_parallel_demand_to_release_before_suppression_lifts() {
        val det = baseDetector()
        val a = det.acquireDemandStay()
        val b = det.acquireDemandStay()
        assertEquals(2, det.snapshot().demandStayCount)
        a()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 10_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
        b()
        det.handle(IdleDetectorEvent.Tick(BASE_IDLE_MS + 20_000))
        assertEquals(IdleDetectorState.IDLE, det.snapshot().state)
    }

    @Test
    fun release_is_idempotent_does_not_underflow_counter() {
        val det = baseDetector()
        val rel = det.acquireDemandStay()
        rel()
        rel()
        assertEquals(0, det.snapshot().demandStayCount)
    }
}

class IdleDetectorSuppressedWarningTest {

    @Test
    fun enters_warning_while_suppressed_so_instrumentation_can_fire() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.CycleStart(0))
        det.handle(IdleDetectorEvent.Tick(BASE_WARNING_MS))
        // Naturally warning — suppression does NOT downgrade to active.
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }
}

class IdleDetectorCustomWarningThresholdTest {

    @Test
    fun honours_explicit_warningThresholdMs_instead_of_default_fraction() {
        val det = createIdleDetector(IdleDetectorConfig(idleThresholdMs = 60_000, warningThresholdMs = 10_000))
        det.handle(IdleDetectorEvent.Tick(9_999))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
        det.handle(IdleDetectorEvent.Tick(10_000))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }

    @Test
    fun zero_warningThresholdMs_transitions_to_warning_on_first_tick_at_anchor() {
        val det = createIdleDetector(IdleDetectorConfig(idleThresholdMs = 60_000, warningThresholdMs = 0))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
        det.handle(IdleDetectorEvent.Tick(0))
        assertEquals(IdleDetectorState.WARNING, det.snapshot().state)
    }
}

class IdleDetectorMonotonicClockTest {

    @Test
    fun ignores_tick_with_nowMs_before_last_anchor() {
        val det = baseDetector()
        det.handle(IdleDetectorEvent.Interaction(10_000))
        // A late / out-of-order tick before the anchor should not drive the machine.
        det.handle(IdleDetectorEvent.Tick(5_000))
        assertEquals(IdleDetectorState.ACTIVE, det.snapshot().state)
    }
}
