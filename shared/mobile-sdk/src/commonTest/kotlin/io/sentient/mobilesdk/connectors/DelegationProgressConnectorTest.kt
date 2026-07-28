// ---------------------------------------------------------------------------
// DelegationProgressConnectorTest — KEEPER: pins the delegation.progress wire
// contract (design §5.4/§7) that Tasks 8/9 render — upsert by taskId, terminal
// states retained, one no-loss event per update.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class DelegationProgressConnectorTest {

    @Test fun progressFrames_upsertByTaskId_andEmitOneEventEach() {
        val events = mutableListOf<SdkEvent>()
        val c = DelegationProgressConnector(onEvent = { events += it })

        c.handle(ServerMessage.DelegationProgress(taskId = "k1", turnId = "t1", agent = "hermes", status = "running"))
        c.handle(ServerMessage.DelegationProgress(taskId = "k2", turnId = "t1", agent = "hermes", status = "running"))
        c.handle(
            ServerMessage.DelegationProgress(
                taskId = "k1", turnId = "t1", agent = "hermes", status = "done", note = "found 3 results",
            ),
        )

        assertEquals(listOf("k1", "k2"), c.list().map { it.taskId }, "upsert in place, arrival order kept")
        assertEquals("done", c.list().first().status)
        assertEquals("found 3 results", c.list().first().note)
        assertEquals(3, events.count { it is SdkEvent.DelegationProgressed }, "one event per frame — never batched")
    }

    @Test fun clear_dropsEveryRow() {
        val c = DelegationProgressConnector()
        c.handle(ServerMessage.DelegationProgress(taskId = "k1", turnId = "t1", agent = "hermes", status = "running"))
        c.clear()
        assertEquals(emptyList(), c.list())
    }
}
