package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class CapturingConversationRepository : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> = MutableStateFlow(emptyList())
    override val liveEvents: SharedFlow<SdkEvent> = MutableSharedFlow()
    override val echoedPendingIds: kotlinx.coroutines.flow.Flow<Set<String>> = MutableStateFlow(emptySet())
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class SendMessageUseCaseTest {

    @Test
    fun queued_entries_drain_only_when_ready() {
        val repo = CapturingConversationRepository()
        val attachedId = MutableStateFlow<String?>("existing-conv")
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")
        cache.enqueue("p2", "world")

        SendMessageUseCase(repo, attachedId).flushIfReady(cache, SdkStatus.READY)

        assertEquals(listOf("hello" to "p1", "world" to "p2"), repo.sent)
        assertTrue(cache.queued().isEmpty(), "drained entries leave the QUEUED set")
    }

    @Test
    fun non_ready_status_is_a_no_op() {
        val repo = CapturingConversationRepository()
        val attachedId = MutableStateFlow<String?>("existing-conv")
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")

        SendMessageUseCase(repo, attachedId).flushIfReady(cache, SdkStatus.RECONNECTING)

        assertTrue(repo.sent.isEmpty(), "no send while not READY")
        assertEquals(1, cache.queued().size, "entry stays QUEUED for the next rising edge")
    }

    @Test
    fun flushed_entries_are_not_resent() {
        val repo = CapturingConversationRepository()
        val attachedId = MutableStateFlow<String?>("existing-conv")
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")
        val useCase = SendMessageUseCase(repo, attachedId)

        useCase.flushIfReady(cache, SdkStatus.READY)
        useCase.flushIfReady(cache, SdkStatus.READY) // reconnect re-fire

        assertEquals(1, repo.sent.size, "a flushed entry is never re-sent on a second flush")
        // No SENT state: the entry stays QUEUED (flushed guard) until its echo removes it.
        assertEquals(MessageStatus.QUEUED, cache.pending.value.single().status)
        assertTrue(cache.queued().isEmpty(), "a flushed entry is excluded from the flushable set")
    }

    @Test
    fun does_not_flush_until_a_session_id_is_attached() {
        val repo = CapturingConversationRepository()
        val attachedId = MutableStateFlow<String?>(null)
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")
        val useCase = SendMessageUseCase(repo, attachedId)

        // READY but no id yet — must be gated
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "gated: READY but no conversation id attached")
        assertEquals(1, cache.queued().size, "entry stays QUEUED while id is unattached")

        // id attaches — flush must succeed now
        attachedId.value = "conv-Y"
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(listOf("hello" to "p1"), repo.sent, "flushes once conversation id is attached")
        assertTrue(cache.queued().isEmpty(), "drained after id attached")
    }
}
