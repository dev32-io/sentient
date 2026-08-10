// ---------------------------------------------------------------------------
// InFlightMessageConnectorTest — ported VERBATIM from web-sdk
// inflight-message-connector.test.ts. FSM/buffer-lifecycle contract:
//   turn.started    → seed empty buffer (thinking placeholder)
//   turn.text.delta → append for turnId (a second open turn keeps its own buffer)
//   turn.completed  → commit + clear (only that turnId's buffer)
//   turn.aborted    → drop (only that turnId's buffer)
// → keeper per .claude/rules/testing.md.
//
// web-sdk uses attach/detach + onMessage; mobile-sdk feeds frames via handle()
// and exposes the buffer through inflight(). Lifetime-reset cases (detach)
// collapse to fresh construction in Kotlin and are not separately ported.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
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
    fun seeds_an_empty_buffer_on_turn_started() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.TurnStarted(turnId = "c-1", trigger = "test"))
        assertEquals(InFlightMessage("c-1", ""), c.inflight())
        assertEquals(InFlightMessage("c-1", ""), updates.last())
    }

    @Test
    fun transitions_seed_to_text_on_first_delta() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnStarted(turnId = "c-1", trigger = "test"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Hi"))
        assertEquals(InFlightMessage("c-1", "Hi"), c.inflight())
    }

    @Test
    fun clears_the_seed_buffer_on_turn_aborted_before_any_delta() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnStarted(turnId = "c-1", trigger = "test"))
        c.handle(ServerMessage.TurnAborted(turnId = "c-1", cutoff = "barge-in"))
        assertNull(c.inflight())
    }

    @Test
    fun accumulates_deltas_for_a_turn() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Hello "))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "world"))
        assertEquals(InFlightMessage("c-1", "Hello world"), c.inflight())
        assertEquals(2, updates.size)
    }

    @Test
    fun clears_inflight_on_turn_completed() {
        val (c, updates) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Hi"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c-1"))
        assertNull(c.inflight())
        assertNull(updates.last())
    }

    @Test
    fun clears_inflight_on_turn_aborted() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Hi"))
        c.handle(ServerMessage.TurnAborted(turnId = "c-1", cutoff = "barge-in"))
        assertNull(c.inflight())
    }

    @Test
    fun ignores_turn_completed_for_a_different_turn() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Hi"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c-2"))
        assertEquals(InFlightMessage("c-1", "Hi"), c.inflight())
    }

    @Test
    fun starts_a_fresh_buffer_when_a_new_turnId_begins() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "First"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c-1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-2", text = "Second"))
        assertEquals(InFlightMessage("c-2", "Second"), c.inflight())
    }

    @Test
    fun newest_open_turn_renders_the_live_bubble() {
        val (c, _) = connectorWithUpdates()
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = "Old"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-2", text = "New"))
        assertEquals(InFlightMessage("c-2", "New"), c.inflight())
    }

    @Test
    fun ignores_malformed_messages() {
        val (c, _) = connectorWithUpdates()
        // Blank turnId or text → no-op (a degraded frame must never seed a buffer).
        c.handle(ServerMessage.TurnTextDelta(turnId = "", text = ""))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c-1", text = ""))
        c.handle(ServerMessage.TurnTextDelta(turnId = "", text = "Hi"))
        assertNull(c.inflight())
    }

    // ── §7.2 multi-turn: two turns can be open at once; neither may clobber the other ──
    // Pins the FSM invariant: the per-turn buffer is keyed by turnId, so a follow-up
    // turn opening mid-stream never discards the earlier turn's accumulated text.

    @Test
    fun twoOpenTurns_accumulateIndependently_andCommitTheirOwnText() {
        val committed = mutableListOf<Pair<String?, String>>()
        val c = InFlightMessageConnector(
            onEvent = { e -> if (e is SdkEvent.MessageCommitted) committed += e.message.turnId to e.message.content },
        )

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "one-"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "two-"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "tail"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "tail"))

        assertEquals("t2", c.inflight()?.turnId, "the newest open turn renders the live bubble")

        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t2"))

        assertEquals(listOf<Pair<String?, String>>("t1" to "one-tail", "t2" to "two-tail"), committed)
        assertNull(c.inflight(), "no buffer left open once both turns completed")
    }

    @Test
    fun abortOfOneTurn_leavesTheOtherTurnsBufferIntact() {
        val committed = mutableListOf<String>()
        val c = InFlightMessageConnector(
            onEvent = { e -> if (e is SdkEvent.MessageCommitted) committed += e.message.content },
        )

        c.handle(ServerMessage.TurnStarted(turnId = "t1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t1", text = "keep-me"))
        c.handle(ServerMessage.TurnStarted(turnId = "t2"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "t2", text = "drop-me"))
        c.handle(ServerMessage.TurnAborted(turnId = "t2", cutoff = "barge-in"))
        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))

        assertEquals(listOf("keep-me"), committed, "aborting t2 must not touch t1's buffer")
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
