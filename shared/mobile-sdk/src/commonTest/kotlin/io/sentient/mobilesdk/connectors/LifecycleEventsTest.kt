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
    fun turn_aborted_frame_emits_event_with_cutoff() {
        val events = mutableListOf<SdkEvent>()
        val c = TurnErrorConnector(onErrorChange = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.TurnAborted(turnId = "c1", cutoff = "interrupt"))
        assertTrue(events.any { it is SdkEvent.TurnAborted && it.turnId == "c1" && it.cutoff == "interrupt" })
    }

    @Test
    fun turn_completed_frame_emits_turn_done_event() {
        val events = mutableListOf<SdkEvent>()
        val c = CognitionStatusConnector(onStateChange = {}, onEvent = { events.add(it) })
        c.handle(ServerMessage.TurnStarted(turnId = "c2"))
        c.handle(ServerMessage.TurnCompleted(turnId = "c2"))
        assertTrue(events.any { it is SdkEvent.TurnDone && it.turnId == "c2" })
    }
}
