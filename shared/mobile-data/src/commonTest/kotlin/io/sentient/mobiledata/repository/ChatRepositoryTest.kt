package io.sentient.mobiledata.repository

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatRepositoryTest {

    // ── Pure reduce — no-loss proof ──────────────────────────────────────────

    @Test
    fun reduce_accumulates_every_delta_in_order() {
        var s = LiveState()
        s = ChatRepository.reduce(s, SdkEvent.MessageStarted("c1"))
        s = ChatRepository.reduce(s, SdkEvent.MessageDelta("c1", "He"))
        s = ChatRepository.reduce(s, SdkEvent.MessageDelta("c1", "llo"))
        assertEquals("Hello", s.live?.content)
        assertEquals(true, s.live?.streaming)
        s = ChatRepository.reduce(s, SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", "c1", "running", "{}", 1L)))
        assertEquals(1, s.tasks.size)
        s = ChatRepository.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 0, role = "assistant", content = "Hello", cycleId = "c1")))
        assertEquals(null, s.live)        // commit clears the live bubble
        assertEquals(0, s.tasks.size)    // and the cycle's tasks
    }

    // ── Flow integration — final-state, conflation-robust ────────────────────

    @Test
    fun chatStream_reflects_committed_timeline_and_accumulated_live() = runTest(UnconfinedTestDispatcher()) {
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(listOf(ChatMessage(ts = 1, role = "user", content = "hi")))
        val repo = ChatRepository(events = events, timeline = timeline, scope = backgroundScope)
        events.emit(SdkEvent.MessageStarted("c1"))
        events.emit(SdkEvent.MessageDelta("c1", "He"))
        events.emit(SdkEvent.MessageDelta("c1", "llo"))
        advanceUntilIdle()
        val r = repo.chatStream.first()
        assertTrue(r is io.sentient.mobiledata.result.SentientResult.Success)
        val m = (r as io.sentient.mobiledata.result.SentientResult.Success).data
        assertEquals(1, m.committed.size)       // from timeline
        assertEquals("Hello", m.live?.content)  // accumulated, no loss
    }
}
