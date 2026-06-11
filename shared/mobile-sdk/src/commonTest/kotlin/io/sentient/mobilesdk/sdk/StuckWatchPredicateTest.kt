// ---------------------------------------------------------------------------
// StuckWatchPredicateTest — table-tests for shouldWatchStuck (A1 predicate).
//
// FSM invariant: arm ONLY when a cycle is active AND the socket is not READY.
// A slow healthy cycle (THINKING + READY) must never arm.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StuckWatchPredicateTest {

    // ── should NOT arm (false) ───────────────────────────────────────────────

    @Test
    fun thinking_not_speaking_ready_should_not_arm() {
        // Healthy slow cycle — socket is READY; no false-fire.
        assertFalse(shouldWatchStuck(CognitionState.THINKING, isSpeaking = false, status = SdkStatus.READY))
    }

    @Test
    fun idle_speaking_ready_should_not_arm() {
        // Speaking but socket healthy — not stuck.
        assertFalse(shouldWatchStuck(CognitionState.IDLE, isSpeaking = true, status = SdkStatus.READY))
    }

    @Test
    fun idle_not_speaking_reconnecting_should_not_arm() {
        // No active cycle and not speaking — nothing to recover.
        assertFalse(shouldWatchStuck(CognitionState.IDLE, isSpeaking = false, status = SdkStatus.RECONNECTING))
    }

    // ── should arm (true) ────────────────────────────────────────────────────

    @Test
    fun thinking_not_speaking_reconnecting_should_arm() {
        // Cycle active + socket dropped → arm.
        assertTrue(shouldWatchStuck(CognitionState.THINKING, isSpeaking = false, status = SdkStatus.RECONNECTING))
    }

    @Test
    fun idle_speaking_disconnected_should_arm() {
        // Speaking (audio in flight) + socket gone → arm.
        assertTrue(shouldWatchStuck(CognitionState.IDLE, isSpeaking = true, status = SdkStatus.DISCONNECTED))
    }
}
