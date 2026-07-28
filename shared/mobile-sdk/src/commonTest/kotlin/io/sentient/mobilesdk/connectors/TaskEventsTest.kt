package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class TaskEventsTest {
    @Test
    fun each_tool_update_emits_upsert_in_order() {
        val events = mutableListOf<SdkEvent>()
        val c = TaskStatusConnector(onList = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.TurnToolUpdate("c1", "t1", "search", "running", null, "{}", 1L))
        c.handle(ServerMessage.TurnToolUpdate("c1", "t2", "calc", "running", null, "{}", 2L))
        c.handle(ServerMessage.TurnToolUpdate("c1", "t1", "search", "done", null, "{}", 1L, endedAtMs = 3L))
        assertEquals(listOf("t1", "t2", "t1"), events.map { (it as SdkEvent.TaskUpserted).task.toolCallId })
        assertEquals("done", (events[2] as SdkEvent.TaskUpserted).task.status)
    }
}
