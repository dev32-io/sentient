package io.sentient.mobiledata.usecase

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RevealReducerTest {
    private val C = "cycle-1"

    @Test fun delta_accumulates_full_reveal_lags() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "Hello world"))
        assertEquals("Hello world", s.bubble?.fullContent)
        assertEquals(0, s.bubble?.revealed)
        assertEquals("", s.visibleContent())
    }

    @Test fun tick_advances_toward_full() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcdefghij"))
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(1_100))
        assertTrue((s.bubble?.revealed ?: 0) in 1..10)
        assertEquals(s.bubble?.revealed, s.visibleContent().length)
    }

    @Test fun commit_drains_then_nulls() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = RevealReducer.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 1, role = "assistant", content = "abcde", cycleId = C)))
        assertEquals(LivePhase.DRAINING, s.bubble?.phase)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
    }

    @Test fun multiple_deltas_accumulate_without_loss() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "He"))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "llo "))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "world"))
        assertEquals("Hello world", s.bubble?.fullContent)
    }

    @Test fun tasks_survive_into_drain_cleared_after() {
        var s = RevealReducer.reduce(RevealState(), SdkEvent.MessageStarted(C))
        s = RevealReducer.reduce(s, SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", C, "running", "", 1L)))
        s = RevealReducer.reduce(s, SdkEvent.MessageDelta(C, "x"))
        s = RevealReducer.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 1, role = "assistant", content = "x", cycleId = C)))
        assertEquals(1, s.tasks.size)
        s = RevealReducer.reduce(s, RevealTick(1_000))
        s = RevealReducer.reduce(s, RevealTick(5_000))
        assertNull(s.bubble)
        assertTrue(s.tasks.isEmpty())
    }
}
