// ---------------------------------------------------------------------------
// TurnErrorConnectorTest — pins the unsolicited-turn-error INVARIANT
// (Task 4, mobile-resilience). turn.aborted is overloaded across UI Stop,
// barge-in, and real wire/server errors; only the last must surface a
// recoverable error. This is a documented FSM invariant → keeper per
// .claude/rules/testing.md.
//
// Feeds the real connector typed frames + the two client-side notes
// (noteInterrupt / noteBargeIn) — no mocks of internals. The connector exposes
// onErrorChange; the orchestrator wires that to deriver.lastTurnError (an
// events-emitted SdkEvent.TurnAborted is the app-facing signal).
//
//   turn.started → interrupt() → turn.aborted ⇒ lastTurnError false
//   turn.started → barge-in    → turn.aborted ⇒ false
//   turn.started → turn.aborted (no note)     ⇒ true
//   then turn.started                         ⇒ cleared to false
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TurnErrorConnectorTest {

    private fun connectorWithChanges(): Pair<TurnErrorConnector, MutableList<Boolean>> {
        val changes = mutableListOf<Boolean>()
        val c = TurnErrorConnector(onErrorChange = { changes += it })
        return c to changes
    }

    private fun started(id: String) = ServerMessage.TurnStarted(turnId = id, trigger = "test")
    private fun aborted(id: String, cutoff: String = "") = ServerMessage.TurnAborted(turnId = id, cutoff = cutoff)

    @Test
    fun has_capability_turn_error() {
        assertEquals("turn.error", TurnErrorConnector().capability)
    }

    @Test
    fun starts_with_no_error() {
        assertFalse(TurnErrorConnector().hasError())
    }

    @Test
    fun interrupt_then_abort_does_not_set_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteInterrupt(null) // UI Stop, no turnId — latches the active turn
        c.handle(aborted("c1", cutoff = "interrupt"))
        assertFalse(c.hasError())
        assertTrue(changes.none { it }) // never went true
    }

    @Test
    fun barge_in_then_abort_does_not_set_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteBargeIn("c1")
        c.handle(aborted("c1")) // bare abort (cutoff absent — a degraded frame)
        assertFalse(c.hasError())
        assertTrue(changes.none { it })
    }

    @Test
    fun unsolicited_abort_sets_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1", cutoff = "error")) // wire-death — no local interrupt/barge-in
        assertTrue(c.hasError())
        assertEquals(listOf(true), changes)
    }

    @Test
    fun bare_unsolicited_abort_sets_error_without_cutoff() {
        // The SDK contract must not depend on the gateway's `cutoff`: a bare
        // turn.aborted (degraded frame / cutoff absent) the client did NOT cause
        // is still an error.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
    }

    @Test
    fun next_turn_started_clears_the_error() {
        val (c, changes) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
        c.handle(started("c2"))
        assertFalse(c.hasError())
        assertEquals(listOf(true, false), changes)
    }

    @Test
    fun turn_completed_before_abort_is_not_an_error() {
        // A completed-then-aborted ReAct continuation: the turn produced a final
        // answer (turn.completed) — a later abort is not a broken chat.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c1"))
        c.handle(aborted("c1", cutoff = "error"))
        assertFalse(c.hasError())
    }

    @Test
    fun successful_turn_clears_a_prior_error() {
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
        c.handle(started("c2"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c2"))
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
    fun note_for_a_different_turn_does_not_exempt_the_active_one() {
        // A stale interrupt note targeting an OLD turn must not suppress a real
        // error on the current turn.
        val (c, _) = connectorWithChanges()
        c.handle(started("c1"))
        c.noteInterrupt("c0") // targets a prior turn, not c1
        c.handle(aborted("c1"))
        assertTrue(c.hasError())
    }

    @Test
    fun abort_for_a_different_turn_is_ignored() {
        val (c, _) = connectorWithChanges()
        c.handle(started("c2"))
        c.handle(aborted("c1")) // abort for a stale turn — not the active one
        assertFalse(c.hasError())
    }

}
