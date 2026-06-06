package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class TaskEventsTest {
    @Test
    fun each_task_update_emits_upsert_in_order() {
        val events = mutableListOf<SdkEvent>()
        val c = TaskStatusConnector(onList = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.TaskUpdate("t1", "search", "c1", "running", "{}", 1L))
        c.handle(ServerMessage.TaskUpdate("t2", "calc", "c1", "running", "{}", 2L))
        c.handle(ServerMessage.TaskUpdate("t1", "search", "c1", "finished", "{}", 1L, endedAtMs = 3L))
        assertEquals(listOf("t1", "t2", "t1"), events.map { (it as SdkEvent.TaskUpserted).task.taskId })
        assertEquals("finished", (events[2] as SdkEvent.TaskUpserted).task.status)
    }
}
