// ---------------------------------------------------------------------------
// StateDeriverToolsTest — pins cycleId stamping + tools attach in StateDeriver.
//
// Three invariants:
//   1. Live inflight bubble gets its cycleId + tools filtered by that cycleId.
//   2. Committed message retains cycleId + tools after inflight clears + feed commits.
//   3. Reloaded history (no inflight seen) has cycleId=null + empty tools.
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
        d.inflight = InFlightMessage(cycleId = "c1", text = "hi")
        val last = d.derive().messages.last()
        assertEquals("c1", last.cycleId)
        assertEquals(listOf("t1"), last.tools.map { it.taskId })
    }

    @Test
    fun committedMessageRetainsCycleToolsAfterCommit() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        d.inflight = InFlightMessage(cycleId = "c1", text = "answer")
        d.inflight = null
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "answer")))
        val committed = d.derive().messages.single()
        assertEquals("c1", committed.cycleId)
        assertEquals(listOf("t1"), committed.tools.map { it.taskId })
    }

    @Test
    fun reloadedHistoryWithoutSeenCycleHasNoTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "old reply")))
        val committed = d.derive().messages.single()
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
