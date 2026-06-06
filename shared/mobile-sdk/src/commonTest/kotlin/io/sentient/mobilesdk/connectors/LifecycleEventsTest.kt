package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertTrue

class LifecycleEventsTest {
    @Test
    fun session_switched_frame_emits_event() {
        val events = mutableListOf<SdkEvent>()
        val c = ConversationHistoryConnector(onUpdate = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.SessionSwitched(sessionId = "s9", ts = 1L))
        assertTrue(events.any { it is SdkEvent.SessionSwitched && it.sessionId == "s9" })
    }

    @Test
    fun cycle_aborted_frame_emits_event_with_kind() {
        val events = mutableListOf<SdkEvent>()
        val c = CycleErrorConnector(onErrorChange = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.CycleAborted(cycleId = "c1", reason = "interrupt"))
        assertTrue(events.any { it is SdkEvent.CycleAborted && it.cycleId == "c1" && it.kind == "interrupt" })
    }

    @Test
    fun cycle_completed_frame_emits_cycle_done_event() {
        val events = mutableListOf<SdkEvent>()
        val c = CognitionStatusConnector(onStateChange = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.CycleStarted(cycleId = "c2"))
        c.handle(ServerMessage.CycleCompleted(cycleId = "c2"))
        assertTrue(events.any { it is SdkEvent.CycleDone && it.cycleId == "c2" })
    }
}
