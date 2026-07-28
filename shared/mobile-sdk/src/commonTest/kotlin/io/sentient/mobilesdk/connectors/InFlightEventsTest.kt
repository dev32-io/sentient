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
        c.handle(ServerMessage.TurnStarted(turnId = "c1"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c1", text = "He"))
        c.handle(ServerMessage.TurnTextDelta(turnId = "c1", text = "llo"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c1"))
        assertEquals(SdkEvent.MessageStarted("c1"), events[0])
        assertEquals(SdkEvent.MessageDelta("c1", "He"), events[1])
        assertEquals(SdkEvent.MessageDelta("c1", "llo"), events[2])
        assertEquals("c1", (events[3] as SdkEvent.MessageCommitted).message.turnId)
    }
}
