// ---------------------------------------------------------------------------
// CognitionStatusConnectorTest — ported VERBATIM from web-sdk
// cognition-status-connector.test.ts. FSM contract: cycle lifecycle →
// simplified client cognition state.
//   cycle.started   → THINKING
//   cycle.completed → IDLE
//   cycle.aborted   → IDLE
// Duplicate-state transitions do NOT fire onStateChange. → keeper.
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
        c.handle(ServerMessage.CycleStarted(cycleId = "c1", triggerKind = "test"))
        assertEquals(listOf(CognitionState.THINKING), changes)
        assertEquals(CognitionState.THINKING, c.state())
    }

    @Test
    fun transitions_to_idle_on_cycle_completed() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.CycleStarted(cycleId = "c1", triggerKind = "test"))
        c.handle(ServerMessage.CycleCompleted(cycleId = "c1"))
        assertEquals(CognitionState.IDLE, changes.last())
        assertEquals(CognitionState.IDLE, c.state())
    }

    @Test
    fun transitions_to_idle_on_cycle_aborted() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.CycleStarted(cycleId = "c1", triggerKind = "test"))
        c.handle(ServerMessage.CycleAborted(cycleId = "c1", reason = "interrupt"))
        assertEquals(CognitionState.IDLE, changes.last())
    }

    @Test
    fun does_not_call_onStateChange_for_duplicate_state() {
        val (c, changes) = connectorWithChanges()
        // Already idle — cycle.completed should be a no-op.
        c.handle(ServerMessage.CycleCompleted(cycleId = "c1"))
        assertEquals(emptyList(), changes)
    }

    @Test
    fun ignores_unowned_frames() {
        val (c, changes) = connectorWithChanges()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "x"))
        assertEquals(emptyList(), changes)
        assertEquals(CognitionState.IDLE, c.state())
    }
}
