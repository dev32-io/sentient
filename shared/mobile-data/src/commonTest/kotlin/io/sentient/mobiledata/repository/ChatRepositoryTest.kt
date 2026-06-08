package io.sentient.mobiledata.repository

import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ChatRepository — the pure 3-way projection (committed timeline + live reveal +
 * pending outbox) → ChatModel. Pins the two combine invariants: one-bubble-per-cycle
 * (committed twin suppressed while its live bubble is on screen) and optimistic
 * reconciliation by pendingId.
 */
class ChatRepositoryTest {

    private fun repo(
        committed: List<ChatMessage>,
        live: LiveState = LiveState(),
        pending: List<PendingMessage> = emptyList(),
    ) = ChatRepository(
        timeline = MutableStateFlow(committed),
        live = MutableStateFlow(live),
        pending = MutableStateFlow(pending),
    )

    private suspend fun ChatRepository.model() =
        (chatStream.first() as SentientResult.Success).data

    @Test
    fun chatStream_combines_committed_and_live() = runTest(UnconfinedTestDispatcher()) {
        val r = repo(
            committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi")),
            live = LiveState(live = LiveBubble("c1", "Hello", revealed = 5, phase = LivePhase.STREAMING)),
        )
        val m = r.model()
        assertEquals(1, m.committed.size)             // from timeline
        assertTrue(m.live != null)
        assertEquals("Hello", m.live?.content)        // revealed slice = take(5)
        assertEquals(true, m.live?.streaming)
        assertEquals("c1", m.live?.cycleId)
    }

    @Test
    fun committed_twin_suppressed_while_live_same_cycle() = runTest(UnconfinedTestDispatcher()) {
        // committed already carries the assistant entry for c1, AND the live bubble
        // is still revealing c1 (post-commit DRAINING). Only ONE bubble must render.
        val r = repo(
            committed = listOf(
                ChatMessage(ts = 1, role = "user", content = "hi"),
                ChatMessage(ts = 2, role = "assistant", content = "Hello world", cycleId = "c1"),
            ),
            live = LiveState(live = LiveBubble("c1", "Hello world", revealed = 5, phase = LivePhase.DRAINING)),
        )
        val m = r.model()
        // the committed c1 twin is hidden while the live bubble drains → no duplicate
        assertEquals(1, m.committed.size)
        assertEquals("user", m.committed[0].role)
        assertEquals("c1", m.live?.cycleId)
    }

    @Test
    fun committed_twin_restored_once_live_settles() = runTest(UnconfinedTestDispatcher()) {
        // live == null (drain done) → the committed assistant entry renders normally.
        val r = repo(
            committed = listOf(
                ChatMessage(ts = 1, role = "user", content = "hi"),
                ChatMessage(ts = 2, role = "assistant", content = "Hello world", cycleId = "c1"),
            ),
            live = LiveState(live = null),
        )
        val m = r.model()
        assertEquals(2, m.committed.size)
        assertEquals(null, m.live)
    }

    @Test
    fun committed_echo_with_matching_pendingId_drops_pending() = runTest(UnconfinedTestDispatcher()) {
        val r = repo(
            committed = listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1")),
            pending = listOf(PendingMessage("p1", "hi", MessageStatus.SENT)),
        )
        val m = r.model()
        assertTrue(m.pending.isEmpty(), "optimistic bubble reconciled away by id, was: ${m.pending}")
        assertEquals(1, m.committed.size)
        assertEquals("p1", m.committed[0].pendingId)
    }
}
