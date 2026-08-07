// ---------------------------------------------------------------------------
// StateDeriverTest — pendingId read-through + the tool/trigger exclusion
// contract in StateDeriver.
//
// The committed/live tile-merge this file used to pin (StateDeriverToolsTest)
// was retired by the tile-derivation-strip task: tool activity no longer folds
// into the chat list at all — it renders in the composer task strip off
// `tasklist.state` (TaskListConnector). What remains here is the pendingId
// read-through (unrelated to tiles) plus a pin that a committed kind:"tool"
// feed item never produces a row.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.protocol.ConversationFeedItem
import kotlin.test.Test
import kotlin.test.assertEquals

class StateDeriverTest {
    @Test
    fun deriveMessages_propagates_pendingId_on_user_entries() {
        val d = StateDeriver(io.sentient.mobilesdk.fakes.FixedClock(1000L))
        d.applyFeed(listOf(
            ConversationFeedItem.User(ts = 1L, channel = "text", content = "hi", pendingId = "p1"),
        ))
        val msgs = d.deriveTimeline()
        val user = msgs.first { it.role == "user" }
        assertEquals("p1", user.pendingId)
    }

    @Test
    fun tool_items_never_render_as_rows() {
        val feed = listOf(
            ConversationFeedItem.User(entryId = "1", ts = 1, channel = "text", content = "hi"),
            ConversationFeedItem.Tool(entryId = "2", ts = 2, toolName = "ma_search", status = "finished", summary = "ok"),
            ConversationFeedItem.Assistant(entryId = "r1", ts = 3, content = "done", replyId = "r1"),
        )
        val out = deriveMessages(feed, inflight = null, nowMs = 10)
        assertEquals(listOf("user", "assistant"), out.map { it.role })
    }
}
