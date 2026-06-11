// ---------------------------------------------------------------------------
// StateDeriverToolsTest — pins cycleId read-through + tools attach in StateDeriver.
//
// Three invariants:
//   1. Live inflight bubble gets its cycleId + tools filtered by that cycleId.
//   2. Committed message carries the gateway cycleId (re-attached on the feed
//      item by the history connector) + tools filtered by it.
//   3. Reloaded history (REST item, no cycleId) has cycleId=null + empty tools.
//
// cycleId is the gateway-owned join key carried on the conversation.entry frame
// and re-attached to the assistant item by ConversationHistoryConnector — the
// client never text-matches/ts-window-stamps it. derive() was removed with the
// legacy SdkState aggregate; this uses deriveMessages()/deriveTimeline() directly.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.util.Clock
import kotlin.test.Test
import kotlin.test.assertEquals

private class FixedClockLocal(private val t: Long) : Clock { override fun nowMs(): Long = t }

private fun task(id: String, cycle: String) = TaskSnapshotItem(
    taskId = id, toolName = "search", cycleId = cycle, status = "finished",
    argsPreview = "q=1", startedAtMs = 1, endedAtMs = 2,
)

class StateDeriverToolsTest {
    @Test
    fun inflightBubbleGetsItsCycleTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"), task("t2", "other"))
        val inflight = InFlightMessage(cycleId = "c1", text = "hi")
        // Use deriveMessages directly (internal, visible from commonTest) to
        // exercise the inflight path — deriveTimeline() commits-only, no bubble.
        val msgs = deriveMessages(feed = emptyList(), inflight = inflight, nowMs = 100, tasks = d.tasks)
        val last = msgs.last()
        assertEquals("c1", last.cycleId)
        assertEquals(listOf("t1"), last.tools.map { it.taskId })
    }

    @Test
    fun committedMessageCarriesFrameCycleAndTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        // The history connector re-attaches the frame cycleId onto the committed
        // assistant item before applyFeed sees it — model that here directly.
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "answer", cycleId = "c1")))
        // deriveTimeline() returns committed-only (no inflight bubble).
        val committed = d.deriveTimeline().single()
        assertEquals("c1", committed.cycleId)
        assertEquals(listOf("t1"), committed.tools.map { it.taskId })
    }

    @Test
    fun reloadedHistoryWithoutCycleHasNoTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "old reply")))
        val committed = d.deriveTimeline().single()
        assertEquals(null, committed.cycleId)
        assertEquals(emptyList(), committed.tools)
    }

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
