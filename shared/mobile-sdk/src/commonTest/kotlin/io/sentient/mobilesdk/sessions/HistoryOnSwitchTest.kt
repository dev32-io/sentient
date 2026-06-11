// ---------------------------------------------------------------------------
// HistoryOnSwitchTest — pins the history-on-switch contract at the
// connector/SDK boundary (Task 2.6).
//
// KEEPER (per .claude/rules/testing.md): history-on-switch is a protocol FSM
// invariant — removing the WS snapshot means the client MUST load history via
// REST on session.switched, or the timeline is permanently empty.
//
// Pins:
//   1. session.switched → connector gate set; REST fetch launched; mirror replaced
//   2. gate cleared (no wedge) after replaceMirror — live entries append normally
//   3. stale-switch guard: fast second switch's fetch wins; first response discarded
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sessions

import io.sentient.mobilesdk.connectors.ConversationHistoryConnector
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

private fun userItem(content: String, ts: Long = 1) =
    ConversationFeedItem.User(ts = ts, channel = "text", content = content)

class HistoryOnSwitchTest {

    // ── Gate semantics post-Task-2.6 ─────────────────────────────────────────

    @Test
    fun session_switched_sets_gate_and_drops_straggler_entries() {
        val c = ConversationHistoryConnector()
        // Pre-load a history from a prior session.
        c.replaceMirror(listOf(userItem("old", ts = 1)), c.currentGeneration())
        assertEquals(1, c.items().size)

        // Switch to a new session — gate arms.
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2L))
        // A straggler entry from the old session should be dropped.
        c.handle(ServerMessage.ConversationEntry(userItem("straggler", ts = 3)))
        assertFalse(
            c.items().any { it is ConversationFeedItem.User && it.content == "straggler" },
            "straggler entry before REST history must be dropped",
        )
    }

    @Test
    fun replaceMirror_clears_gate_and_live_entries_append() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 1L))
        val gen = c.currentGeneration()

        // REST history arrives.
        c.replaceMirror(listOf(userItem("loaded", ts = 10)), gen)
        assertEquals(1, c.items().size, "mirror should contain REST history")

        // Live entry after gate released should append normally.
        c.handle(ServerMessage.ConversationEntry(userItem("live", ts = 20)))
        assertEquals(2, c.items().size, "live entry must append after gate cleared")
    }

    // ── Stale-switch guard ───────────────────────────────────────────────────

    @Test
    fun stale_fetch_does_not_overwrite_newer_switch_history() {
        val c = ConversationHistoryConnector()
        // Switch #1.
        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))
        val gen1 = c.currentGeneration()

        // Fast second switch before first fetch arrives.
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2L))
        val gen2 = c.currentGeneration()

        // First (stale) fetch arrives.
        c.replaceMirror(listOf(userItem("from s1")), gen1)
        assertEquals(emptyList(), c.items(), "stale fetch must not populate mirror")

        // Second (current) fetch arrives.
        c.replaceMirror(listOf(userItem("from s2")), gen2)
        assertEquals(1, c.items().size, "current fetch must populate mirror")
        assertEquals("from s2", (c.items()[0] as ConversationFeedItem.User).content)
    }

    @Test
    fun generation_increments_on_each_switch() {
        val c = ConversationHistoryConnector()
        val g0 = c.currentGeneration()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))
        val g1 = c.currentGeneration()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2L))
        val g2 = c.currentGeneration()

        assertEquals(g0 + 1, g1, "generation must increment on first switch")
        assertEquals(g1 + 1, g2, "generation must increment on second switch")
    }

    @Test
    fun error_empty_replaceMirror_still_clears_gate() {
        // Even if REST returns empty (network error → empty fallback),
        // the gate must clear so the connector does not wedge.
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))
        val gen = c.currentGeneration()

        // REST error → empty list.
        c.replaceMirror(emptyList(), gen)
        assertEquals(emptyList(), c.items(), "empty REST response populates empty mirror")

        // Live entry must now append (gate clear).
        c.handle(ServerMessage.ConversationEntry(userItem("live")))
        assertEquals(1, c.items().size, "live entry must flow after error-cleared gate")
    }
}
