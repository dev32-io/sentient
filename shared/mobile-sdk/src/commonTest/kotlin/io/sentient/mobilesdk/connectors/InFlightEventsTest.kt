package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class InFlightEventsTest {
    @Test
    fun emits_started_then_each_delta_in_order_then_done() {
        val events = mutableListOf<SdkEvent>()
        val c = InFlightMessageConnector(onUpdate = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.CycleStarted(cycleId = "c1"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "He"))
        c.handle(ServerMessage.MessageDelta(cycleId = "c1", delta = "llo"))
        c.handle(ServerMessage.MessageDone(cycleId = "c1"))
        assertEquals(SdkEvent.MessageStarted("c1"), events[0])
        assertEquals(SdkEvent.MessageDelta("c1", "He"), events[1])
        assertEquals(SdkEvent.MessageDelta("c1", "llo"), events[2])
        assertEquals("c1", (events[3] as SdkEvent.MessageCommitted).message.cycleId)
    }
}
