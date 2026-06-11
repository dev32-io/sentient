// ---------------------------------------------------------------------------
// ConversationHistoryConnectorTest — FSM/mirror contract post-Task-2.6.
//
// KEEPER (per .claude/rules/testing.md): snapshot gate semantics — stragglers
// between session.switched and the REST history arriving are dropped, then the
// gate releases when replaceMirror() is called.
//
// Post-Task-2.1 changes:
//   - The gateway no longer sends conversation.snapshot on session.switched.
//   - History is loaded via REST; the orchestrator calls replaceMirror() with
//     the result, releasing the gate.
//   - The stale-switch guard: replaceMirror(forGeneration) is a no-op if the
//     generation has advanced (a fast second switch superseded this fetch).
//   - conversation.snapshot still handled for forward-compat / legacy gateways.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

private fun userItem(content: String, ts: Long = 1) =
    ConversationFeedItem.User(ts = ts, channel = "text", content = content)

private fun assistantItem(content: String, ts: Long = 2) =
    ConversationFeedItem.Assistant(ts = ts, content = content)

private fun toolItem(summary: String, ts: Long = 3) =
    ConversationFeedItem.Tool(ts = ts, toolName = "speak", status = "finished", summary = summary)

class ConversationHistoryConnectorTest {

    @Test
    fun has_capability_conversation_history() {
        assertEquals("conversation.history", ConversationHistoryConnector().capability)
    }

    @Test
    fun starts_with_an_empty_mirror() {
        assertEquals(emptyList(), ConversationHistoryConnector().items())
    }

    // ── replaceMirror hydrates the mirror (REST path) ─────────────────────────

    @Test
    fun replaceMirror_hydrates_mirror_and_fires_callbacks() {
        var snapshots = 0
        var updates = 0
        val c = ConversationHistoryConnector(
            onSnapshot = { snapshots++ },
            onUpdate = { updates++ },
        )

        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 1L))
        val gen = c.currentGeneration()
        c.replaceMirror(listOf(userItem("hi"), assistantItem("hello")), gen)

        assertEquals(2, c.items().size)
        assertEquals(userItem("hi"), c.items()[0])
        assertEquals(1, snapshots)
        assertEquals(1, updates)
    }

    @Test
    fun replaceMirror_releases_gate_so_entries_append() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 1L))
        val gen = c.currentGeneration()
        c.replaceMirror(listOf(userItem("loaded", ts = 1)), gen)

        c.handle(ServerMessage.ConversationEntry(userItem("live", ts = 5)))
        assertEquals(2, c.items().size)
    }

    @Test
    fun stale_replaceMirror_is_discarded_when_generation_advanced() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.SessionSwitched(sessionId = "s1", ts = 1L))
        val oldGen = c.currentGeneration()
        // Fast second switch before the first fetch arrives.
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2L))
        val newGen = c.currentGeneration()

        // The first (stale) REST response arrives with the old generation.
        c.replaceMirror(listOf(userItem("stale from s1")), oldGen)
        assertEquals(emptyList(), c.items(), "stale response must NOT update mirror")

        // The current REST response arrives with the new generation.
        c.replaceMirror(listOf(userItem("fresh from s2")), newGen)
        assertEquals(1, c.items().size)
        assertEquals("fresh from s2", (c.items()[0] as ConversationFeedItem.User).content)
    }

    // ── entry gate ────────────────────────────────────────────────────────────

    @Test
    fun entry_between_session_switched_and_replaceMirror_is_dropped() {
        val c = ConversationHistoryConnector()
        c.replaceMirror(listOf(userItem("a", ts = 1)), c.currentGeneration())
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2))
        c.handle(ServerMessage.ConversationEntry(userItem("stale", ts = 3)))
        assertFalse(c.items().any { it is ConversationFeedItem.User && it.content == "stale" })
    }

    @Test
    fun entry_without_prior_switched_still_applies() {
        val c = ConversationHistoryConnector()
        c.replaceMirror(emptyList(), c.currentGeneration())
        c.handle(ServerMessage.ConversationEntry(userItem("live", ts = 1)))
        assertEquals(1, c.items().size)
    }

    // ── conversation.snapshot forward-compat ─────────────────────────────────

    @Test
    fun snapshot_legacy_frame_still_hydrates_mirror() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("hi"), assistantItem("hello"))))
        assertEquals(2, c.items().size)
        assertEquals(userItem("hi"), c.items()[0])
    }

    @Test
    fun subsequent_snapshot_replaces_does_not_merge() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("old", ts = 1))))
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("new", ts = 2))))
        assertEquals(1, c.items().size)
        assertEquals("new", (c.items()[0] as ConversationFeedItem.User).content)
    }

    // ── entry appends ─────────────────────────────────────────────────────────

    @Test
    fun appends_on_conversation_entry() {
        var entries = 0
        var updates = 0
        val c = ConversationHistoryConnector(
            onEntry = { entries++ },
            onUpdate = { updates++ },
        )

        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(userItem("hi")))
        c.handle(ServerMessage.ConversationEntry(assistantItem("hello")))
        c.handle(ServerMessage.ConversationEntry(toolItem("said hi")))

        assertEquals(3, c.items().size)
        assertEquals(listOf("user", "assistant", "tool"), c.items().map { it.kindName() })
        assertEquals(3, entries)
        // 1 for snapshot + 3 for entries.
        assertEquals(4, updates)
    }

    @Test
    fun reattaches_frame_cycleId_onto_committed_assistant_entry() {
        var emitted: ConversationFeedItem? = null
        val c = ConversationHistoryConnector(onEntry = { emitted = it })

        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(assistantItem("hello"), cycleId = "c-1"))

        val item = c.items().single()
        assertEquals("c-1", (item as ConversationFeedItem.Assistant).cycleId)
        assertEquals("c-1", (emitted as ConversationFeedItem.Assistant).cycleId)
    }

    @Test
    fun leaves_cycleId_null_when_frame_carries_none() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(assistantItem("hello")))
        assertEquals(null, (c.items().single() as ConversationFeedItem.Assistant).cycleId)
    }

    @Test
    fun handles_missing_items_in_snapshot_gracefully() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot())
        assertEquals(emptyList(), c.items())
    }

    @Test
    fun ignores_unowned_frames() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "x"))
        assertEquals(emptyList(), c.items())
    }
}

private fun ConversationFeedItem.kindName(): String = when (this) {
    is ConversationFeedItem.User -> "user"
    is ConversationFeedItem.Trigger -> "trigger"
    is ConversationFeedItem.Assistant -> "assistant"
    is ConversationFeedItem.Tool -> "tool"
}
