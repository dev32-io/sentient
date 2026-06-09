// ---------------------------------------------------------------------------
// InFlightMessageConnectorTest — ported VERBATIM from web-sdk
// inflight-message-connector.test.ts. FSM/buffer-lifecycle contract:
//   cycle.started  → seed empty buffer (thinking placeholder)
//   message.delta  → append for cycleId (replace on new cycleId mid-stream)
//   message.done   → clear (only for current cycleId)
//   cycle.aborted  → clear (only for current cycleId)
// → keeper per .claude/rules/testing.md.
//
// web-sdk uses attach/detach + onMessage; mobile-sdk feeds frames via handle()
// and exposes the buffer through inflight(). Lifetime-reset cases (detach)
// collapse to fresh construction in Kotlin and are not separately ported.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class InFlightMessageConnectorTest {

    private fun connectorWithUpdates(): Pair<InFlightMessageConnector, MutableList<InFlightMessage?>> {
        val updates = mutableListOf<InFlightMessage?>()
        val c = InFlightMessageConnector(onUpdate = { updates += it })
        return c to updates
    }

    @Test
    fun has_capability_message_stream() {
        assertEquals("message.stream", InFlightMessageConnector().capability)
    }

    @Test
    fun starts_with_null_inflight() {
        assertNull(InFlightMessageConnector().inflight())
    }

    @Test
    fun seeds_an_empty_buffer_on_cycle_started() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.CycleStarted(cycleId = "c-1", triggerKind = "test"))
        assertEquals(InFlightMessage("c-1", ""), c.inflight())
        assertEquals(InFlightMessage("c-1", ""), updates.last())
    }

    @Test
    fun transitions_seed_to_text_on_first_delta() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.CycleStarted(cycleId = "c-1", triggerKind = "test"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Hi"))
        assertEquals(InFlightMessage("c-1", "Hi"), c.inflight())
    }

    @Test
    fun clears_the_seed_buffer_on_cycle_aborted_before_any_delta() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.CycleStarted(cycleId = "c-1", triggerKind = "test"))
        c.handle(ServerMessage.CycleAborted(cycleId = "c-1", reason = "barge-in"))
        assertNull(c.inflight())
    }

    @Test
    fun accumulates_deltas_for_a_cycle() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Hello "))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "world"))
        assertEquals(InFlightMessage("c-1", "Hello world"), c.inflight())
        assertEquals(2, updates.size)
    }

    @Test
    fun clears_inflight_on_message_done() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Hi"))
        c.handle(ServerMessage.MessageDone(cycleId = "c-1"))
        assertNull(c.inflight())
        assertNull(updates.last())
    }

    @Test
    fun clears_inflight_on_cycle_aborted() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Hi"))
        c.handle(ServerMessage.CycleAborted(cycleId = "c-1", reason = "barge-in"))
        assertNull(c.inflight())
    }

    @Test
    fun ignores_message_done_for_a_different_cycle() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Hi"))
        c.handle(ServerMessage.MessageDone(cycleId = "c-2"))
        assertEquals(InFlightMessage("c-1", "Hi"), c.inflight())
    }

    @Test
    fun starts_a_fresh_buffer_when_a_new_cycleId_begins() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "First"))
        c.handle(ServerMessage.MessageDone(cycleId = "c-1"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-2", delta = "Second"))
        assertEquals(InFlightMessage("c-2", "Second"), c.inflight())
    }

    @Test
    fun replaces_buffer_if_a_new_cycleId_arrives_mid_stream() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = "Old"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-2", delta = "New"))
        assertEquals(InFlightMessage("c-2", "New"), c.inflight())
    }

    @Test
    fun ignores_malformed_messages() {
        val (c, _) = connectorWithUpdates()
        // Missing cycleId or delta → no-op (matches TS guard on cycleId + delta).
        c.handle(ServerMessage.MessageDelta(cycleId = null, delta = null))
        c.handle(ServerMessage.MessageDelta(cycleId = "c-1", delta = null))
        c.handle(ServerMessage.MessageDelta(cycleId = null, delta = "Hi"))
        assertNull(c.inflight())
    }

    @Test
    fun ignores_unowned_frames() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItemUser("x")))
        assertNull(c.inflight())
    }
}

private fun ConversationFeedItemUser(content: String) =
    io.sentient.mobilesdk.protocol.ConversationFeedItem.User(ts = 1, channel = "text", content = content)
