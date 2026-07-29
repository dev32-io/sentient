// ---------------------------------------------------------------------------
// StateDeriverToolsTest — pins turnId read-through + tools attach in StateDeriver.
//
// Three invariants:
//   1. Live inflight bubble gets its turnId + tools filtered by that turnId.
//   2. Committed message carries the gateway turnId (re-attached on the feed
//      item by the history connector) + tools filtered by it.
//   3. Reloaded history (REST item, no turnId) has turnId=null + empty tools.
//
// turnId is the gateway-owned join key carried on the conversation.entry frame
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

private fun task(id: String, turn: String) = TaskSnapshotItem(
    toolCallId = id, toolName = "search", turnId = turn, status = "done",
    argsPreview = "q=1", startedAtMs = 1, endedAtMs = 2,
)

private fun userItem(ts: Long, content: String) =
    ConversationFeedItem.User(ts = ts, channel = "text", content = content)

private fun toolItem(entryId: String, ts: Long, toolName: String) =
    ConversationFeedItem.Tool(entryId = entryId, ts = ts, toolName = toolName, status = "finished", summary = "20C")

private fun replyItem(entryId: String, ts: Long, content: String, turnId: String? = null) =
    ConversationFeedItem.Assistant(entryId = entryId, ts = ts, content = content, turnId = turnId)

class StateDeriverToolsTest {
    @Test
    fun inflightBubbleGetsItsTurnTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"), task("t2", "other"))
        val inflight = InFlightMessage(turnId = "c1", text = "hi")
        // Use deriveMessages directly (internal, visible from commonTest) to
        // exercise the inflight path — deriveTimeline() commits-only, no bubble.
        val msgs = deriveMessages(feed = emptyList(), inflight = inflight, nowMs = 100, tasks = d.tasks)
        val last = msgs.last()
        assertEquals("c1", last.turnId)
        assertEquals(listOf("t1"), last.tools.map { it.toolCallId })
    }

    @Test
    fun committedMessageCarriesFrameTurnAndTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        // The history connector re-attaches the frame turnId onto the committed
        // assistant item before applyFeed sees it — model that here directly.
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "answer", turnId = "c1")))
        // deriveTimeline() returns committed-only (no inflight bubble).
        val committed = d.deriveTimeline().single()
        assertEquals("c1", committed.turnId)
        assertEquals(listOf("t1"), committed.tools.map { it.toolCallId })
    }

    @Test
    fun reloadedHistoryWithoutTurnHasNoTools() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("t1", "c1"))
        d.applyFeed(listOf(ConversationFeedItem.Assistant(ts = 50, content = "old reply")))
        val committed = d.deriveTimeline().single()
        assertEquals(null, committed.turnId)
        assertEquals(emptyList(), committed.tools)
    }

    // ── Committed tool tiles — RENDERED-layer convergence (spec §3.2) ─────────
    //
    // Mirrors gateway/webui/src/hooks/cycle-helpers.test.ts. A tool call reaches
    // this client twice: live as turn.tool.update, committed as a kind:"tool"
    // feed item. Only the committed one survives a reload, so a timeline rebuilt
    // from conversation.snapshot / REST history must derive the SAME tiles as the
    // live turn — otherwise render(replay) == render(live) holds on the wire and
    // fails at the layer the reload oracle actually reads.

    @Test
    fun committedToolItemRendersATileWhenNoLiveTaskExists() {
        val d = StateDeriver(FixedClockLocal(100))
        d.applyFeed(
            listOf(
                userItem(1, "weather?"),
                toolItem("e-2", 2, "get_weather"),
                replyItem("e-3", 3, "20 degrees"),
            ),
        )

        val reply = d.deriveTimeline().last()
        assertEquals(listOf("get_weather"), reply.tools.map { it.toolName })
        // The tile's identity is the gateway-owned entryId — never a position.
        assertEquals(listOf("e-2"), reply.tools.map { it.toolCallId })
    }

    @Test
    fun committedAndLiveTilesForTheSameCallRenderOnce() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("call-1", "c1"))
        d.applyFeed(
            listOf(
                userItem(1, "weather?"),
                toolItem("e-2", 2, "search"),
                replyItem("e-3", 3, "20 degrees", turnId = "c1"),
            ),
        )

        // The committed tile wins — it is the one a reload would show.
        assertEquals(listOf("e-2"), d.deriveTimeline().last().tools.map { it.toolCallId })
    }

    @Test
    fun aStillRunningCallRendersAlongsideItsTurnsCommittedTiles() {
        val d = StateDeriver(FixedClockLocal(100))
        d.tasks = listOf(task("call-1", "c1"), task("call-2", "c1").copy(status = "running", startedAtMs = 9))
        d.applyFeed(
            listOf(
                userItem(1, "weather then lights"),
                toolItem("e-2", 2, "get_weather"),
                replyItem("e-3", 3, "checking the lights", turnId = "c1"),
            ),
        )

        assertEquals(listOf("e-2", "call-2"), d.deriveTimeline().last().tools.map { it.toolCallId })
    }

    @Test
    fun replayedFeedDerivesTheSameTilesAsTheLiveTurn() {
        // Live: the committed assistant entry carries the frame turnId and the
        // live task list is still populated. Replay: the same feed arrives via
        // snapshot / REST (no turnId anywhere) and the task list is empty.
        val liveFeed = listOf(
            userItem(1, "weather?"),
            toolItem("e-2", 2, "search"),
            replyItem("e-3", 3, "20 degrees", turnId = "c1"),
        )
        val replayFeed = liveFeed.map { if (it is ConversationFeedItem.Assistant) it.copy(turnId = null) else it }

        val live = StateDeriver(FixedClockLocal(100))
        live.tasks = listOf(task("call-1", "c1"))
        live.applyFeed(liveFeed)
        val replay = StateDeriver(FixedClockLocal(100))
        replay.applyFeed(replayFeed)

        assertEquals(
            live.deriveTimeline().map { m -> "${m.content}::${m.tools.map { it.toolName }}" },
            replay.deriveTimeline().map { m -> "${m.content}::${m.tools.map { it.toolName }}" },
        )
    }

    @Test
    fun aCommittedTileNeverCrossesTheNextUserEntry() {
        val d = StateDeriver(FixedClockLocal(100))
        d.applyFeed(
            listOf(
                userItem(1, "do it"),
                toolItem("e-2", 2, "set_lights"),
                userItem(3, "never mind"),
                replyItem("e-4", 4, "ok"),
            ),
        )

        assertEquals(emptyList(), d.deriveTimeline().last().tools)
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
