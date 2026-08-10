// ---------------------------------------------------------------------------
// StateDeriverTest — pendingId read-through in StateDeriver.
//
// The committed/live tile-merge this file used to pin (StateDeriverToolsTest)
// was retired by the tile-derivation-strip task: tool activity no longer folds
// into the chat list at all — it renders in the composer task strip off
// `tasklist.state` (TaskListConnector). The follow-on pin that a committed
// kind:"tool" feed item produced no row went with the feed item itself: there
// is no tool item on the wire any more, so there is nothing left to exclude.
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
}
