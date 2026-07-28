// ---------------------------------------------------------------------------
// TaskStatusConnectorTest — ported from web-sdk task-status-connector.test.ts.
// Pins the turn.tool.update parse contract + the list() ordering invariant
// (startedAtMs ascending) + upsert-by-toolCallId + the turnId threading.
// Wire-shape contract at the gateway↔SDK boundary → keeper per
// .claude/rules/testing.md.
//
// The TS "rejects missing field" guard maps onto the sealed wire schema:
// a frame missing turnId/toolCallId decodes to ServerMessage.Unknown (covered by
// the WireJson polymorphic-default contract test, not here). The equivalent here
// is "ignores unowned frames".
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskStatusConnectorTest {

    private fun update(
        toolCallId: String,
        toolName: String = "tool",
        turnId: String = "turn-1",
        status: String = "running",
        argsPreview: String = "",
        startedAtMs: Long = 1000L,
        endedAtMs: Long? = null,
        taskId: String? = null,
    ) = ServerMessage.TurnToolUpdate(
        turnId = turnId,
        toolCallId = toolCallId,
        toolName = toolName,
        status = status,
        argsPreview = argsPreview,
        startedAtMs = startedAtMs,
        endedAtMs = endedAtMs,
        taskId = taskId,
    )

    @Test
    fun has_capability_task_status() {
        assertEquals("task.status", TaskStatusConnector().capability)
    }

    @Test
    fun starts_with_an_empty_list() {
        assertEquals(emptyList(), TaskStatusConnector().list())
    }

    @Test
    fun parses_tool_update_and_threads_turnId_into_snapshot() {
        val updates = mutableListOf<TaskSnapshotItem>()
        val c = TaskStatusConnector(onUpdate = { updates += it })

        c.handle(update(toolCallId = "t-1", toolName = "search", turnId = "turn-1", argsPreview = "query=hello"))

        val items = c.list()
        assertEquals(1, items.size)
        assertEquals(
            TaskSnapshotItem(
                toolCallId = "t-1",
                toolName = "search",
                turnId = "turn-1",
                status = "running",
                argsPreview = "query=hello",
                startedAtMs = 1000L,
            ),
            items[0],
        )
        assertEquals(listOf(items[0]), updates)
    }

    @Test
    fun preserves_distinct_turnIds_across_tool_calls() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t1", toolName = "play_music", turnId = "turn-A", startedAtMs = 100L))
        c.handle(update(toolCallId = "t2", toolName = "run_scene", turnId = "turn-B", startedAtMs = 200L))

        val items = c.list()
        assertEquals(2, items.size)
        assertEquals("turn-A", items.first { it.toolCallId == "t1" }.turnId)
        assertEquals("turn-B", items.first { it.toolCallId == "t2" }.turnId)
    }

    @Test
    fun updates_rows_by_toolCallId_on_subsequent_updates() {
        val updates = mutableListOf<TaskSnapshotItem>()
        val lists = mutableListOf<List<TaskSnapshotItem>>()
        val c = TaskStatusConnector(onUpdate = { updates += it }, onList = { lists += it })

        c.handle(update(toolCallId = "t-1", toolName = "search", argsPreview = "query=hello"))
        c.handle(
            update(
                toolCallId = "t-1",
                toolName = "search",
                status = "finished",
                argsPreview = "query=hello",
                endedAtMs = 2000L,
            ),
        )

        assertEquals(1, c.list().size)
        assertEquals("finished", c.list()[0].status)
        assertEquals(2000L, c.list()[0].endedAtMs)
        assertEquals(2, updates.size)
        assertEquals(2, lists.size)
    }

    @Test
    fun maintains_order_by_startedAtMs_ascending() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t-2", toolName = "tool2", startedAtMs = 2000L))
        c.handle(update(toolCallId = "t-1", toolName = "tool1", startedAtMs = 1000L))

        val items = c.list()
        assertEquals(2, items.size)
        assertEquals("t-1", items[0].toolCallId)
        assertEquals("t-2", items[1].toolCallId)
    }

    @Test
    fun defaults_argsPreview_to_empty_string_when_blank() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t-1", toolName = "tool"))
        assertEquals("", c.list()[0].argsPreview)
    }

    @Test
    fun keeps_terminal_rows_in_the_list_with_endedAtMs() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t-1", status = "finished", endedAtMs = 5000L))
        assertEquals(1, c.list().size)
        assertEquals(5000L, c.list()[0].endedAtMs)
    }

    @Test
    fun clear_empties_the_list() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t-1"))
        assertEquals(1, c.list().size)
        c.clear()
        assertEquals(0, c.list().size)
    }

    @Test
    fun ignores_unowned_frames() {
        val c = TaskStatusConnector()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.TurnStarted(turnId = "c1"))
        assertEquals(emptyList(), c.list())
    }

    @Test
    fun background_tool_carries_its_taskId_onto_the_snapshot() {
        // delegateTask is the BACKGROUND archetype: the frame's taskId is the handle
        // Tasks 8/9 join a delegation row to its tool tile. A foreground call has none.
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "tc-1", toolName = "delegateTask", taskId = "task-9"))
        c.handle(update(toolCallId = "tc-2", toolName = "readFile", startedAtMs = 1001L))
        assertEquals("task-9", c.list().first { it.toolCallId == "tc-1" }.taskId)
        assertNull(c.list().first { it.toolCallId == "tc-2" }.taskId)
    }

    @Test
    fun running_row_has_null_endedAtMs() {
        val c = TaskStatusConnector()
        c.handle(update(toolCallId = "t-1"))
        assertNull(c.list()[0].endedAtMs)
    }
}
