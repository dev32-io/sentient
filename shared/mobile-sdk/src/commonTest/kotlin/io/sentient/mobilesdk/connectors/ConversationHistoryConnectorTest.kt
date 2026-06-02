// ---------------------------------------------------------------------------
// ConversationHistoryConnectorTest — ported VERBATIM from web-sdk
// conversation-history-connector.test.ts. FSM/mirror contract: snapshot
// REPLACES, entry APPENDS, and the awaitingSnapshot generation gate drops
// stragglers between session.switched and the next snapshot → keeper.
//
// web-sdk uses attach/detach + per-type onMessage; mobile-sdk feeds every
// decoded ServerMessage through handle() (broadcast-and-filter). The
// detach/re-attach reset cases map to fresh connector construction in Kotlin
// (the orchestrator owns lifetime) and so are not ported as separate cases.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

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

    @Test
    fun hydrates_the_mirror_from_conversation_snapshot() {
        var snapshots = 0
        var updates = 0
        val c = ConversationHistoryConnector(
            onSnapshot = { snapshots++ },
            onUpdate = { updates++ },
        )

        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("hi"), assistantItem("hello"))))

        assertEquals(2, c.items().size)
        assertEquals(userItem("hi"), c.items()[0])
        assertEquals(1, snapshots)
        assertEquals(1, updates)
    }

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
    fun handles_missing_items_in_snapshot_gracefully() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot())
        assertEquals(emptyList(), c.items())
    }

    @Test
    fun subsequent_snapshot_replaces_does_not_merge() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("old", ts = 1))))
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("new", ts = 2))))
        assertEquals(1, c.items().size)
        assertEquals("new", (c.items()[0] as ConversationFeedItem.User).content)
    }

    @Test
    fun entry_between_session_switched_and_next_snapshot_is_dropped() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("a", ts = 1))))
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2))
        c.handle(ServerMessage.ConversationEntry(userItem("stale", ts = 3)))
        assertFalse(c.items().any { it is ConversationFeedItem.User && it.content == "stale" })
    }

    @Test
    fun snapshot_after_session_switched_releases_the_gate() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("a", ts = 1))))
        c.handle(ServerMessage.SessionSwitched(sessionId = "s2", ts = 2))
        c.handle(ServerMessage.ConversationSnapshot(items = listOf(userItem("fresh", ts = 4))))
        assertEquals(1, c.items().size)
        assertEquals("fresh", (c.items()[0] as ConversationFeedItem.User).content)
        c.handle(ServerMessage.ConversationEntry(userItem("live", ts = 5)))
        assertEquals(2, c.items().size)
    }

    @Test
    fun entry_without_prior_switched_still_applies() {
        val c = ConversationHistoryConnector()
        c.handle(ServerMessage.ConversationSnapshot(items = emptyList()))
        c.handle(ServerMessage.ConversationEntry(userItem("live", ts = 1)))
        assertEquals(1, c.items().size)
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
