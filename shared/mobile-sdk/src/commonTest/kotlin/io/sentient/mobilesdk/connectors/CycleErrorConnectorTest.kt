// ---------------------------------------------------------------------------
// CycleErrorConnectorTest — pins the unsolicited-cycle-error INVARIANT
// (Task 4, mobile-resilience). cycle.aborted is overloaded across UI Stop,
// barge-in, and real wire/server errors; only the last must surface a
// recoverable error. This is a documented FSM invariant → keeper per
// .claude/rules/testing.md.
//
// Feeds the real connector typed frames + the two client-side notes
// (noteInterrupt / noteBargeIn) — no mocks of internals. The deriver fold is
// covered separately by asserting onErrorChange drives the flag the orchestrator
// writes into SdkState.lastCycleError.
//
//   cycle.started → interrupt() → cycle.aborted ⇒ lastCycleError false
//   cycle.started → barge-in    → cycle.aborted ⇒ false
//   cycle.started → cycle.aborted (no note)     ⇒ true
//   then cycle.started                          ⇒ cleared to false
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.sdk.StateDeriver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CycleErrorConnectorTest {

    private fun connectorWithChanges(): Pair<CycleErrorConnector, MutableList<Boolean>> {
        val changes = mutableListOf<Boolean>()
        val c = CycleErrorConnector(onErrorChange = { changes += it })
        return c to changes
    }

    private fun started(id: String) = ServerMessage.CycleStarted(cycleId = id, triggerKind = "test")
    private fun aborted(id: String, reason: String? = null) = ServerMessage.CycleAborted(cycleId = id, reason = reason)

    @Test
    fun has_capability_cycle_error() {
        assertEquals("cycle.error", CycleErrorConnector().capability)
    }

    @Test
    fun starts_with_no_error() {
        assertFalse(CycleErrorConnector().hasError())
    }

    @Test
    fun interrupt_then_abort_does_not_set_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteInterrupt(null) // UI Stop, no cycleId — latches the active cycle
        c.handle(aborted("c1", reason = "interrupt"))
        assertFalse(c.hasError())
        assertTrue(changes.none { it }) // never went true
    }

    @Test
    fun barge_in_then_abort_does_not_set_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteBargeIn("c1")
        c.handle(aborted("c1")) // bare abort (reason absent — barge-in carries none)
        assertFalse(c.hasError())
        assertTrue(changes.none { it })
    }

    @Test
    fun unsolicited_abort_sets_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1", reason = "error")) // wire-death — no local interrupt/barge-in
        assertTrue(c.hasError())
        assertEquals(listOf(true), changes)
    }

    @Test
    fun bare_unsolicited_abort_sets_error_without_reason() {
        // The SDK contract must not depend on the gateway's `reason`: a bare
        // cycle.aborted (older gateway / reason absent) the client did NOT cause
        // is still an error.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
    }

    @Test
    fun next_cycle_started_clears_the_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
        c.handle(started("c2"))
        assertFalse(c.hasError())
        assertEquals(listOf(true, false), changes)
    }

    @Test
    fun message_done_before_abort_is_not_an_error() {
        // A completed-then-aborted ReAct continuation: the cycle produced a final
        // answer (message.done) — a later abort is not a broken chat.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(ServerMessage.MessageDone(cycleId = "c1"))
        c.handle(aborted("c1", reason = "error"))
        assertFalse(c.hasError())
    }

    @Test
    fun successful_cycle_clears_a_prior_error() {
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
        c.handle(started("c2"))
        c.handle(ServerMessage.MessageDone(cycleId = "c2"))
        assertFalse(c.hasError())
    }

    @Test
    fun reset_clears_the_error() {
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
        c.reset()
        assertFalse(c.hasError())
    }

    @Test
    fun note_for_a_different_cycle_does_not_exempt_the_active_one() {
        // A stale interrupt note targeting an OLD cycle must not suppress a real
        // error on the current cycle.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteInterrupt("c0") // targets a prior cycle, not c1
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
    }

    @Test
    fun abort_for_a_different_cycle_is_ignored() {
        val (c, _) = connectorWithChanges()
        c.handle(started("c2"))
        c.handle(aborted("c1")) // abort for a stale cycle — not the active one
        assertFalse(c.hasError())
    }

    @Test
    fun folds_into_sdk_state_via_deriver() {
        // The orchestrator wires onErrorChange → deriver.lastCycleError → derive().
        // Pin that the flag actually reaches the single SdkState surface.
        val deriver = StateDeriver(FixedClock())
        val c = CycleErrorConnector(onErrorChange = { deriver.lastCycleError = it })
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(deriver.derive().lastCycleError)
        c.handle(started("c2"))
        assertFalse(deriver.derive().lastCycleError)
    }
}
