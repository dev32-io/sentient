package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeConversationRepository : ConversationRepository {
    val timelineState = MutableStateFlow<List<ChatMessage>>(emptyList())
    val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val liveEvents: SharedFlow<SdkEvent> = events
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class ObserveChatUseCaseTest {

    private fun useCase(repo: ConversationRepository) = ObserveChatUseCase(repo, clock = Clock { 0L })

    @Test
    fun committed_twin_suppressed_while_live_same_cycle() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "Hello", cycleId = "c1"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("c1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "Hello"))
        runCurrent()
        val m = models.last()
        assertEquals(1, m.committed.size)          // user only; assistant c1 suppressed by live bubble
        assertEquals("user", m.committed[0].role)
        assertEquals("c1", m.live?.cycleId)
        job.cancel()
    }

    @Test
    fun pending_reconciled_by_id() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1"))
        val pending = MutableStateFlow(listOf(PendingMessage("p1", "hi", MessageStatus.SENT)))
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(pending).collect { models.add(it) } }
        runCurrent()
        val m = models.last()
        assertTrue(m.pending.isEmpty(), "echo with same pendingId reconciles the optimistic bubble")
        assertEquals(1, m.committed.size)
        job.cancel()
    }

    @Test
    fun session_switch_drops_live_bubble() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("c1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "partial"))
        runCurrent()
        assertTrue(models.last().live != null, "live bubble present mid-reply")
        repo.events.emit(SdkEvent.SessionSwitched("s2"))
        runCurrent()
        assertNull(models.last().live, "live bubble dropped on session switch")
        job.cancel()
    }
}
