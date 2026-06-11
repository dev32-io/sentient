// ---------------------------------------------------------------------------
// ReconnectResumeDecisionTest — the pure decision unit for the A1-vs-resume
// reconciliation (Task 3.10-mobile, Slice 3).
//
// KEEPER (per .claude/rules/testing.md): pins the FSM invariant that drives
// whether a reconnect-to-READY PRESERVES the in-flight cycle (recovered resume)
// or CLEARS to idle (no-resume A1 / recovered:false). The bug it guards: the
// Slice-1 A1 path cleared cognition→IDLE UNCONDITIONALLY before stream.resumed,
// dropping the very state a recovered:true resume exists to preserve.
//
// Pure function — no platform, no orchestrator, no I/O. Exhaustive over the
// decision table.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import kotlin.test.Test
import kotlin.test.assertEquals

class ReconnectResumeDecisionTest {

    // ── decideOnReady ─────────────────────────────────────────────────────────

    @Test
    fun first_connect_has_nothing_to_restore() {
        // wasReconnect=false → first-ever READY; anchor/resume flags are irrelevant.
        assertEquals(
            ReadyAction.NOTHING_TO_RESTORE,
            decideOnReady(wasReconnect = false, hasAnchor = false, resumeWillBeAttempted = false),
        )
        assertEquals(
            ReadyAction.NOTHING_TO_RESTORE,
            decideOnReady(wasReconnect = false, hasAnchor = true, resumeWillBeAttempted = true),
        )
    }

    @Test
    fun reconnect_without_anchor_has_nothing_to_reestablish() {
        assertEquals(
            ReadyAction.NO_ANCHOR,
            decideOnReady(wasReconnect = true, hasAnchor = false, resumeWillBeAttempted = false),
        )
        // Even if a resume cursor exists, with no anchor there is no session to defer for.
        assertEquals(
            ReadyAction.NO_ANCHOR,
            decideOnReady(wasReconnect = true, hasAnchor = false, resumeWillBeAttempted = true),
        )
    }

    @Test
    fun reconnect_with_anchor_and_resume_defers() {
        // The fix: a resume IS in flight → do NOT clear here; wait for stream.resumed.
        assertEquals(
            ReadyAction.DEFER_TO_RESUME,
            decideOnReady(wasReconnect = true, hasAnchor = true, resumeWillBeAttempted = true),
        )
    }

    @Test
    fun reconnect_with_anchor_but_no_cursor_runs_legacy_a1() {
        // No resume possible (lastSeq==0) → the old A1 path: re-establish + clear.
        assertEquals(
            ReadyAction.REESTABLISH_AND_CLEAR,
            decideOnReady(wasReconnect = true, hasAnchor = true, resumeWillBeAttempted = false),
        )
    }

    // ── decideOnResumed ───────────────────────────────────────────────────────

    @Test
    fun recovered_true_preserves_in_flight() {
        assertEquals(ResumedAction.PRESERVE_IN_FLIGHT, decideOnResumed(recovered = true))
    }

    @Test
    fun recovered_false_recovers_to_idle() {
        assertEquals(ResumedAction.RECOVER_TO_IDLE, decideOnResumed(recovered = false))
    }
}
