package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.TaskListItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskListConnectorTest {
    @Test
    fun declares_the_tasklist_capability() {
        assertEquals("tasklist", TaskListConnector().capability)
    }

    @Test
    fun replaces_the_whole_list_on_every_frame() {
        val seen = mutableListOf<Pair<String?, List<TaskListItem>>>()
        val c = TaskListConnector(onUpdate = { turnId, items -> seen += turnId to items })

        c.handle(
            ServerMessage.TaskListState(
                turnId = "t1",
                items = listOf(TaskListItem(id = "a", toolName = "x", status = "running")),
            ),
        )
        assertEquals(1, c.list().size)
        assertEquals("t1", c.turnId())

        c.handle(ServerMessage.TaskListState(turnId = null, items = emptyList()))
        assertEquals(0, c.list().size)
        assertNull(c.turnId())
        assertEquals(2, seen.size)
    }

    @Test
    fun ignores_frames_it_does_not_own() {
        val c = TaskListConnector()
        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))
        assertEquals(0, c.list().size)
    }

    @Test
    fun clear_dropsEveryRowAndRefiresOnUpdate() {
        val seen = mutableListOf<Pair<String?, List<TaskListItem>>>()
        val c = TaskListConnector(onUpdate = { turnId, items -> seen += turnId to items })
        c.handle(
            ServerMessage.TaskListState(
                turnId = "t1",
                items = listOf(TaskListItem(id = "a", toolName = "x", status = "running")),
            ),
        )

        c.clear()

        assertEquals(emptyList(), c.list())
        assertNull(c.turnId())
        // The re-fire is the whole point: it's what lets a consumer (SentientSdk.tasks)
        // actually observe the clear, unlike this connector's retired predecessor,
        // whose clear() reset internal state but never re-invoked its callback and so
        // left every consumer holding stale rows forever.
        assertEquals(listOf("t1" to listOf(TaskListItem(id = "a", toolName = "x", status = "running")), null to emptyList()), seen)
    }

    @Test
    fun clear_isANoOpWhenAlreadyEmpty() {
        val seen = mutableListOf<Pair<String?, List<TaskListItem>>>()
        val c = TaskListConnector(onUpdate = { turnId, items -> seen += turnId to items })

        c.clear()

        assertEquals(emptyList<Pair<String?, List<TaskListItem>>>(), seen, "no frame ever arrived — nothing to re-fire")
    }
}
