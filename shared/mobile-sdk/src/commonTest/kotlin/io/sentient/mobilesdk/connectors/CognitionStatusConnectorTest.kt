// ---------------------------------------------------------------------------
// CognitionStatusConnectorTest — lifecycle → simplified client cognition state
// plus monotonic newest-turn ownership. Duplicate global-state transitions do NOT fire
// onStateChange; identity ownership still updates. → keeper.
//
// NOTE: the TS declares a third CognitionState "acting" but the
// cognition-status-connector NEVER reaches it — acting is reserved for a
// task-driven surface. We port the enum verbatim (idle/thinking/acting) and the
// exact idle↔thinking transition table; "acting" stays unreached here, matching
// the TS.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class CognitionStatusConnectorTest {

    private fun connectorWithChanges(): Pair<CognitionStatusConnector, MutableList<CognitionState>> {
        val changes = mutableListOf<CognitionState>()
        val c = CognitionStatusConnector(onStateChange = { changes += it })
        return c to changes
    }

    @Test
    fun has_capability_cognition_status() {
        assertEquals("cognition.status", CognitionStatusConnector().capability)
    }

    @Test
    fun starts_in_idle_state() {
        assertEquals(CognitionState.IDLE, CognitionStatusConnector().state())
    }

    @Test
    fun transitions_to_thinking_on_cycle_started() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.TurnStarted(turnId = "c1", trigger = "test"))
        assertEquals(listOf(CognitionState.THINKING), changes)
        assertEquals(CognitionState.THINKING, c.state())
    }

    @Test
    fun transitions_to_idle_on_cycle_completed() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.TurnStarted(turnId = "c1", trigger = "test"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c1"))
        assertEquals(CognitionState.IDLE, changes.last())
        assertEquals(CognitionState.IDLE, c.state())
    }

    @Test
    fun transitions_to_idle_on_cycle_aborted() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.TurnStarted(turnId = "c1", trigger = "test"))
        c.handle(ServerMessage.TurnAborted(turnId = "c1", cutoff = "interrupt"))
        assertEquals(CognitionState.IDLE, changes.last())
    }

    @Test
    fun does_not_call_onStateChange_for_duplicate_state() {
        val (c, changes) = connectorWithChanges()
        // Already idle — cycle.completed should be a no-op.
        c.handle(ServerMessage.TurnCompleted(turnId = "c1"))
        assertEquals(emptyList(), changes)
    }

    @Test
    fun completing_older_turn_does_not_clear_newer_owner() {
        val owners = mutableListOf<Pair<CognitionState, String?>>()
        val c = CognitionStatusConnector(onActivityChange = { state, turnId -> owners += state to turnId })

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))

        assertEquals(CognitionState.IDLE, c.state(), "global cognition keeps existing web-compatible transition")
        assertEquals(CognitionState.THINKING to "t2", owners.last())
    }

    @Test
    fun older_overlapping_turn_never_reclaims_presentation() {
        val owners = mutableListOf<Pair<CognitionState, String?>>()
        val c = CognitionStatusConnector(onActivityChange = { state, turnId -> owners += state to turnId })

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t2"))

        assertEquals(CognitionState.IDLE, c.state(), "global cognition keeps existing web-compatible transition")
        assertEquals(CognitionState.IDLE to null, owners.last())

        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))
        assertEquals(CognitionState.IDLE to null, owners.last())
    }

    @Test
    fun ignores_unowned_frames() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.TurnTextDelta(turnId = "c1", text = "x"))
        assertEquals(emptyList(), changes)
        assertEquals(CognitionState.IDLE, c.state())
    }

    // ── reset() — connector-drift fix ───────────────────────────────────────

    @Test
    fun reset_forces_idle_and_next_cycle_started_still_fires_onStateChange() {
        // Simulate connector stuck in THINKING (e.g. dead socket, no cycle.aborted).
        // reset() clears it; the next cycle.started must STILL fire onStateChange(THINKING)
        // — proving no short-circuit drift.
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.TurnStarted(turnId = "c1", trigger = "test"))
        assertEquals(listOf(CognitionState.THINKING), changes)
        changes.clear()

        // Optimistic local clear (interrupt / stuck-timeout / reconnect path).
        c.reset()
        assertEquals(listOf(CognitionState.IDLE), changes)
        assertEquals(CognitionState.IDLE, c.state())
        changes.clear()

        // Next cycle arrives on the recovered socket — must NOT short-circuit.
        c.handle(ServerMessage.TurnStarted(turnId = "c2", trigger = "test"))
        assertEquals(listOf(CognitionState.THINKING), changes)
        assertEquals(CognitionState.THINKING, c.state())
    }

    @Test
    fun reset_is_noop_when_already_idle() {
        val (c, changes) = connectorWithChanges()
        // Connector starts IDLE; reset() on an already-IDLE connector must not fire.
        c.reset()
        assertEquals(emptyList(), changes)
        assertEquals(CognitionState.IDLE, c.state())
    }
}
