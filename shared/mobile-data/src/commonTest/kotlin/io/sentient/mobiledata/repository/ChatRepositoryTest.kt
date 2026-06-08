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
        // fullContent accumulates without loss; revealed lags (no ticks yet)
        assertEquals("Hello", s.live?.fullContent)
        assertTrue(s.live != null)
        s = ChatRepository.reduce(s, SdkEvent.TaskUpserted(TaskSnapshotItem("t1", "search", "c1", "running", "{}", 1L)))
        assertEquals(1, s.tasks.size)
        s = ChatRepository.reduce(s, SdkEvent.MessageCommitted(ChatMessage(ts = 0, role = "assistant", content = "Hello", cycleId = "c1")))
        // commit transitions to DRAINING (not immediately null); tasks survive drain
        assertEquals(LivePhase.DRAINING, s.live?.phase)
        // drive two ticks far apart to flush drain completely
        s = ChatRepository.reduce(s, io.sentient.mobiledata.repository.RevealEvent.Tick(1_000))
        s = ChatRepository.reduce(s, io.sentient.mobiledata.repository.RevealEvent.Tick(5_000))
        assertEquals(null, s.live)        // drain complete
        assertEquals(0, s.tasks.size)    // tasks cleared after drain
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
        assertEquals(1, m.committed.size)   // from timeline
        // live bubble exists (streaming=true); content is the revealed slice (lags without ticks)
        assertTrue(m.live != null)
        assertEquals(true, m.live?.streaming)
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
        repo.setConnected(true)

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
    fun send_while_connected_flushes_immediately() = runTest(UnconfinedTestDispatcher()) {
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

        repo.setConnected(true)
        repo.send("hi")

        // send callback invoked immediately — no extra setConnected call needed
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
    fun send_while_disconnected_stays_queued_until_connected() = runTest(UnconfinedTestDispatcher()) {
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
        // connected=false by default — callback must NOT have been invoked yet
        assertTrue(sendCalls.isEmpty(), "Expected no send callback while disconnected, but got: $sendCalls")

        repo.setConnected(true)
        // now it must flush
        assertEquals(1, sendCalls.size)
        assertEquals("hi", sendCalls[0].first)
        assertEquals("p1", sendCalls[0].second)
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
        repo.setConnected(true)

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

    @Test
    fun retry_requeues_failed_and_sends_when_connected() = runTest(UnconfinedTestDispatcher()) {
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

        // Send while disconnected → QUEUED; fail it
        repo.send("hi")
        repo.failOutbox("auth dead")

        // Verify: connecting does NOT resend a FAILED message
        repo.setConnected(true)
        assertTrue(sendCalls.isEmpty(), "FAILED message must not be sent on reconnect, but got: $sendCalls")

        val afterFail = (repo.chatStream.first() as SentientResult.Success).data
        assertEquals(MessageStatus.FAILED, afterFail.pending[0].status)

        // Now retry: should re-queue and flush immediately (already connected)
        repo.retry("p1")
        assertEquals(1, sendCalls.size)
        assertEquals("hi", sendCalls[0].first)
        assertEquals("p1", sendCalls[0].second)

        val afterRetry = (repo.chatStream.first() as SentientResult.Success).data
        assertEquals(MessageStatus.SENT, afterRetry.pending[0].status)
    }
}
