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

private fun triggerItem(summary: String, ts: Long = 3) =
    ConversationFeedItem.Trigger(ts = ts, source = "background-completion", summary = summary)

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
        c.handle(ServerMessage.ConversationEntry(triggerItem("task finished")))

        assertEquals(3, c.items().size)
        assertEquals(listOf("user", "assistant", "trigger"), c.items().map { it.kindName() })
        assertEquals(3, entries)
        // 1 for snapshot + 3 for entries.
        assertEquals(4, updates)
    }

    @Test
    fun reattaches_frame_turnId_onto_committed_assistant_entry() {
        var emitted: ConversationFeedItem? = null
        val c = ConversationHistoryConnector(onEntry = { emitted = it })

        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(assistantItem("hello"), turnId = "c-1"))

        val item = c.items().single()
        assertEquals("c-1", (item as ConversationFeedItem.Assistant).turnId)
        assertEquals("c-1", (emitted as ConversationFeedItem.Assistant).turnId)
    }

    @Test
    fun leaves_turnId_null_when_frame_carries_none() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(assistantItem("hello")))
        assertEquals(null, (c.items().single() as ConversationFeedItem.Assistant).turnId)
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
        c.handle(ServerMessage.TurnTextDelta(turnId = "c1", text = "x"))
        assertEquals(emptyList(), c.items())
    }

    // ── clearForNewChat — local "+" clear (bug #1) ────────────────────────────

    @Test
    fun clearForNewChat_empties_mirror_and_fires_callbacks() {
        var snapshots = 0
        var updates = 0
        val c = ConversationHistoryConnector(onSnapshot = { snapshots++ }, onUpdate = { updates++ })
        c.replaceMirror(listOf(userItem("hi"), assistantItem("hey")), forGeneration = c.currentGeneration())
        snapshots = 0
        updates = 0

        c.clearForNewChat()

        assertEquals(emptyList(), c.items())
        assertEquals(1, snapshots)
        assertEquals(1, updates)
    }

    @Test
    fun clearForNewChat_bumps_generation_so_a_stale_rest_fetch_is_discarded() {
        val c = ConversationHistoryConnector()
        val staleGen = c.currentGeneration()
        c.clearForNewChat()
        // A REST response captured before the "+" tap must NOT overwrite the now-empty chat.
        c.replaceMirror(listOf(userItem("from old session")), forGeneration = staleGen)
        assertEquals(emptyList(), c.items())
    }

    @Test
    fun clearForNewChat_does_not_arm_the_gate_so_the_new_cycle_first_entry_shows() {
        val c = ConversationHistoryConnector()
        c.clearForNewChat()
        // The first entry of the brand-new chat's cycle must reach the mirror,
        // not be dropped as an awaiting-history straggler.
        c.handle(ServerMessage.ConversationEntry(userItem("first message in new chat")))
        assertEquals(1, c.items().size)
    }

    // ── clearForSwitch — local clear on user-initiated switch (Problem 1) ──────

    @Test
    fun clearForSwitch_empties_mirror_and_fires_callbacks() {
        var snapshots = 0
        var updates = 0
        val c = ConversationHistoryConnector(onSnapshot = { snapshots++ }, onUpdate = { updates++ })
        c.replaceMirror(listOf(userItem("old a"), assistantItem("old b")), forGeneration = c.currentGeneration())
        snapshots = 0
        updates = 0

        c.clearForSwitch()

        assertEquals(emptyList(), c.items())
        assertEquals(1, snapshots)
        assertEquals(1, updates)
    }

    @Test
    fun clearForSwitch_arms_the_gate_so_a_straggler_from_the_outgoing_session_drops() {
        val c = ConversationHistoryConnector()
        c.replaceMirror(listOf(userItem("old")), forGeneration = c.currentGeneration())
        c.clearForSwitch()
        // A late entry from the session we are leaving must NOT repopulate the cleared chat.
        c.handle(ServerMessage.ConversationEntry(assistantItem("late straggler")))
        assertEquals(emptyList(), c.items())
    }

    @Test
    fun clearForSwitch_gate_releases_when_target_history_loads() {
        val c = ConversationHistoryConnector()
        c.clearForSwitch()
        // The target session's REST history fills the mirror + releases the gate.
        c.replaceMirror(listOf(userItem("target msg")), forGeneration = c.currentGeneration())
        assertEquals(1, c.items().size)
    }

    // ── entryId dedup — replace-in-place on resume/reconnect ─────────────────

    @Test
    fun duplicate_entryId_replaces_in_place_not_appends() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 2, content = "first")))
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e2", ts = 3, content = "second")))
        assertEquals(2, c.items().size)
        // Re-deliver e1 (the non-tail item, e.g. a committed entry replayed on resume).
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 2, content = "first-updated")))
        assertEquals(2, c.items().size, "duplicate entryId must replace in place, not double-append")
        // Replaced in its original slot; the tail item is not displaced.
        assertEquals("first-updated", (c.items()[0] as ConversationFeedItem.Assistant).content)
        assertEquals("e2", c.items()[1].entryId)
    }

    @Test
    fun distinct_entryIds_still_append() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 1, content = "a")))
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e2", ts = 2, content = "b")))
        assertEquals(2, c.items().size)
    }

    @Test
    fun empty_entryId_is_never_deduped() {
        val c = ConversationHistoryConnector()
        // entryId defaults to UNKNOWN_ENTRY_ID ("") — those have no identity, must not collapse.
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.User(ts = 1, channel = "text", content = "a")))
        c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.User(ts = 2, channel = "text", content = "b")))
        assertEquals(2, c.items().size, "empty entryId must not collapse distinct entries")
    }
}

private fun ConversationFeedItem.kindName(): String = when (this) {
    is ConversationFeedItem.User -> "user"
    is ConversationFeedItem.Trigger -> "trigger"
    is ConversationFeedItem.Assistant -> "assistant"
    is ConversationFeedItem.Unknown -> "unknown"
}
