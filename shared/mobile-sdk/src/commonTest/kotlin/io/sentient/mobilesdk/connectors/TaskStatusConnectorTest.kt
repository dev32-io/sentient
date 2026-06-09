// ---------------------------------------------------------------------------
// TaskStatusConnectorTest — ported VERBATIM from web-sdk
// task-status-connector.test.ts. Pins the task.update parse contract + the
// list() ordering invariant (startedAtMs ascending) + upsert-by-taskId + the
// cycleId threading. Wire-shape contract at the gateway↔SDK boundary → keeper
// per .claude/rules/testing.md.
//
// The TS "rejects missing field" guard maps onto the sealed wire schema:
// ServerMessage.TaskUpdate enforces non-null taskId/toolName/cycleId/status/
// startedAtMs at decode, so a frame missing one decodes to ServerMessage.Unknown
// (covered by the WireJson polymorphic-default contract test, not here). The
// equivalent here is "ignores unowned frames".
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskStatusConnectorTest {

    private fun update(
        taskId: String,
        toolName: String = "tool",
        cycleId: String = "cycle-1",
        status: String = "running",
        argsPreview: String = "",
        startedAtMs: Long = 1000L,
        endedAtMs: Long? = null,
    ) = ServerMessage.TaskUpdate(
        taskId = taskId,
        toolName = toolName,
        cycleId = cycleId,
        status = status,
        argsPreview = argsPreview,
        startedAtMs = startedAtMs,
        endedAtMs = endedAtMs,
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
    fun parses_task_update_and_threads_cycleId_into_snapshot() {
        val updates = mutableListOf<TaskSnapshotItem>()
        val c = TaskStatusConnector(onUpdate = { updates += it })

        c.handle(update(taskId = "t-1", toolName = "search", cycleId = "cycle-1", argsPreview = "query=hello"))

        val items = c.list()
        assertEquals(1, items.size)
        assertEquals(
            TaskSnapshotItem(
                taskId = "t-1",
                toolName = "search",
                cycleId = "cycle-1",
                status = "running",
                argsPreview = "query=hello",
                startedAtMs = 1000L,
            ),
            items[0],
        )
        assertEquals(listOf(items[0]), updates)
    }

    @Test
    fun preserves_distinct_cycleIds_across_tasks() {
        val c = TaskStatusConnector()
        c.handle(update(taskId = "t1", toolName = "play_music", cycleId = "cycle-A", startedAtMs = 100L))
        c.handle(update(taskId = "t2", toolName = "run_scene", cycleId = "cycle-B", startedAtMs = 200L))

        val items = c.list()
        assertEquals(2, items.size)
        assertEquals("cycle-A", items.first { it.taskId == "t1" }.cycleId)
        assertEquals("cycle-B", items.first { it.taskId == "t2" }.cycleId)
    }

    @Test
    fun updates_tasks_by_taskId_on_subsequent_updates() {
        val updates = mutableListOf<TaskSnapshotItem>()
        val lists = mutableListOf<List<TaskSnapshotItem>>()
        val c = TaskStatusConnector(onUpdate = { updates += it }, onList = { lists += it })

        c.handle(update(taskId = "t-1", toolName = "search", argsPreview = "query=hello"))
        c.handle(
            update(
                taskId = "t-1",
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
        c.handle(update(taskId = "t-2", toolName = "tool2", startedAtMs = 2000L))
        c.handle(update(taskId = "t-1", toolName = "tool1", startedAtMs = 1000L))

        val items = c.list()
        assertEquals(2, items.size)
        assertEquals("t-1", items[0].taskId)
        assertEquals("t-2", items[1].taskId)
    }

    @Test
    fun defaults_argsPreview_to_empty_string_when_blank() {
        val c = TaskStatusConnector()
        c.handle(update(taskId = "t-1", toolName = "tool"))
        assertEquals("", c.list()[0].argsPreview)
    }

    @Test
    fun keeps_terminal_tasks_in_the_list_with_endedAtMs() {
        val c = TaskStatusConnector()
        c.handle(update(taskId = "t-1", status = "finished", endedAtMs = 5000L))
        assertEquals(1, c.list().size)
        assertEquals(5000L, c.list()[0].endedAtMs)
    }

    @Test
    fun clear_empties_the_list() {
        val c = TaskStatusConnector()
        c.handle(update(taskId = "t-1"))
        assertEquals(1, c.list().size)
        c.clear()
        assertEquals(0, c.list().size)
    }

    @Test
    fun ignores_unowned_frames() {
        val c = TaskStatusConnector()
        c.handle(ServerMessage.Pong)
        c.handle(ServerMessage.CycleStarted(cycleId = "c1"))
        assertEquals(emptyList(), c.list())
    }

    @Test
    fun running_task_has_null_endedAtMs() {
        val c = TaskStatusConnector()
        c.handle(update(taskId = "t-1"))
        assertNull(c.list()[0].endedAtMs)
    }
}
