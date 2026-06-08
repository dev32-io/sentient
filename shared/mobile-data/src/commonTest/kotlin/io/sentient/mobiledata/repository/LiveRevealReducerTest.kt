package io.sentient.mobiledata.repository

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobiledata.repository.ReplyStreamRepository.Companion.reduce
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LiveRevealReducerTest {
    private val C = "cycle-1"

    @Test fun delta_accumulates_full_but_reveal_lags() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "Hello world"))
        assertEquals("Hello world", s.live?.fullContent)
        assertEquals(0, s.live?.revealed)
        assertEquals("", s.visibleContent())
    }

    @Test fun reveal_tick_advances_toward_full() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "abcdefghij"))
        s = reduce(s, RevealEvent.Tick(1_000))
        s = reduce(s, RevealEvent.Tick(1_100))
        assertTrue((s.live?.revealed ?: 0) in 3..10)
        assertEquals(s.live?.revealed, s.visibleContent().length)
    }

    @Test fun commit_drains_until_reveal_catches_up() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.MessageDelta(C, "abcde"))
        s = reduce(s, SdkEvent.MessageCommitted(committedAssistant(C, "abcde")))
        assertTrue(s.live != null)
        assertEquals(LivePhase.DRAINING, s.live?.phase)
        s = reduce(s, RevealEvent.Tick(1_000))
        s = reduce(s, RevealEvent.Tick(5_000))
        assertNull(s.live)
    }

    @Test fun tasks_survive_into_drain() {
        var s = reduce(LiveState(), SdkEvent.MessageStarted(C))
        s = reduce(s, SdkEvent.TaskUpserted(task(C, "t1", "running")))
        s = reduce(s, SdkEvent.MessageDelta(C, "x"))
        s = reduce(s, SdkEvent.MessageCommitted(committedAssistant(C, "x")))
        assertEquals(1, s.tasks.size)
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun committedAssistant(cycleId: String, content: String): ChatMessage =
        ChatMessage(ts = 1L, role = "assistant", content = content, cycleId = cycleId)

    private fun task(cycleId: String, taskId: String, status: String): TaskSnapshotItem =
        TaskSnapshotItem(
            taskId = taskId,
            toolName = "search",
            cycleId = cycleId,
            status = status,
            argsPreview = "",
            startedAtMs = 1L,
        )
}
