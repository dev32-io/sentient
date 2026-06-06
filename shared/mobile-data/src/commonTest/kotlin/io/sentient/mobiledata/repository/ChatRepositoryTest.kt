package io.sentient.mobiledata.repository

import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.result.SentientResult
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
import kotlin.test.assertNotNull
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
        val repo = ChatRepository(
            events = events,
            timeline = timeline,
            scope = backgroundScope,
            send = { _, _ -> },
            newId = { "x" },
        )
        events.emit(SdkEvent.MessageStarted("c1"))
        events.emit(SdkEvent.MessageDelta("c1", "He"))
        events.emit(SdkEvent.MessageDelta("c1", "llo"))
        advanceUntilIdle()
        val r = repo.chatStream.first()
        assertTrue(r is SentientResult.Success)
        val m = (r as SentientResult.Success).data
        assertEquals(1, m.committed.size)       // from timeline
        assertEquals("Hello", m.live?.content)  // accumulated, no loss
    }

    // ── Outbox — optimistic pending + reconciliation ─────────────────────────

    @Test
    fun send_adds_optimistic_queued_pending() = runTest(UnconfinedTestDispatcher()) {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
        val repo = ChatRepository(
            events = events,
            timeline = timeline,
            scope = backgroundScope,
            send = { text, id -> sendCalls.add(text to id) },
            newId = { "p1" },
        )

        repo.send("hi")

        val r = repo.chatStream.first()
        assertTrue(r is SentientResult.Success)
        val m = (r as SentientResult.Success).data
        assertEquals(1, m.pending.size)
        assertEquals("p1", m.pending[0].id)
        assertEquals("hi", m.pending[0].text)
        assertEquals(MessageStatus.QUEUED, m.pending[0].status)
        // send callback NOT invoked yet — connection not ready
        assertTrue(sendCalls.isEmpty())
    }

    @Test
    fun onReady_flushes_pending_to_sent_and_invokes_send() = runTest(UnconfinedTestDispatcher()) {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
        val repo = ChatRepository(
            events = events,
            timeline = timeline,
            scope = backgroundScope,
            send = { text, id -> sendCalls.add(text to id) },
            newId = { "p1" },
        )

        repo.send("hi")
        repo.onReady()

        // send callback invoked exactly once with correct args
        assertEquals(1, sendCalls.size)
        assertEquals("hi", sendCalls[0].first)
        assertEquals("p1", sendCalls[0].second)

        val r = repo.chatStream.first()
        assertTrue(r is SentientResult.Success)
        val m = (r as SentientResult.Success).data
        assertEquals(1, m.pending.size)
        assertEquals(MessageStatus.SENT, m.pending[0].status)
    }

    @Test
    fun committed_echo_with_matching_pendingId_drops_pending() = runTest(UnconfinedTestDispatcher()) {
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
        val repo = ChatRepository(
            events = events,
            timeline = timeline,
            scope = backgroundScope,
            send = { _, _ -> },
            newId = { "p1" },
        )

        repo.send("hi")
        repo.onReady()

        // gateway echoes back a committed user message carrying the same pendingId
        timeline.value = listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1"))

        val r = repo.chatStream.first()
        assertTrue(r is SentientResult.Success)
        val m = (r as SentientResult.Success).data
        // optimistic bubble reconciled away
        assertTrue(m.pending.isEmpty(), "Expected pending to be empty after echo, but was: ${m.pending}")
        // committed entry is present
        assertEquals(1, m.committed.size)
        assertEquals("p1", m.committed[0].pendingId)
    }

    @Test
    fun failOutbox_marks_pending_failed_and_keeps_visible() = runTest(UnconfinedTestDispatcher()) {
        val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
        val timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
        val repo = ChatRepository(
            events = events,
            timeline = timeline,
            scope = backgroundScope,
            send = { _, _ -> },
            newId = { "p1" },
        )

        repo.send("hi")
        // no onReady — message stays QUEUED, then we fail it
        repo.failOutbox("auth dead")

        val r = repo.chatStream.first()
        assertTrue(r is SentientResult.Success)
        val m = (r as SentientResult.Success).data
        assertEquals(1, m.pending.size)
        assertEquals(MessageStatus.FAILED, m.pending[0].status)
    }
}
