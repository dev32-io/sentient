package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import io.sentient.mobilesdk.sdk.ConnectionState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private class CapturingConversationRepository : ConversationRepository {
    override val timeline: StateFlow<List<ChatMessage>> = MutableStateFlow(emptyList())
    override val tasks: StateFlow<List<TaskListItem>> = MutableStateFlow(emptyList())
    override val liveEvents: SharedFlow<SdkEvent> = MutableSharedFlow()
    override val echoedPendingIds: kotlinx.coroutines.flow.Flow<Set<String>> = MutableStateFlow(emptySet())
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

private fun cacheForRoute(generation: Long): OutboundCache =
    OutboundCache().apply { bindToRoute(generation) }

private fun sendUseCase(
    repo: CapturingConversationRepository,
    authorizedId: MutableStateFlow<String?>,
    routeGeneration: MutableStateFlow<Long?> = MutableStateFlow(1L),
    transportGeneration: MutableStateFlow<Long> = MutableStateFlow(0L),
) = SendMessageUseCase(repo, authorizedId, routeGeneration, transportGeneration)

class SendMessageUseCaseTest {
    @Test
    fun unchanged_READY_authority_and_pending_changes_drain_automatically_once() = runTest {
        val repo = CapturingConversationRepository()
        val authority = MutableStateFlow<String?>(null)
        val epoch = MutableStateFlow<Long?>(1)
        val connection = MutableStateFlow(ConnectionState(status = SdkStatus.READY))
        val cache = cacheForRoute(1)
        val transport = MutableStateFlow(0L)
        val useCase = sendUseCase(repo, authority, epoch, transport)
        backgroundScope.launch { useCase.observeReadiness(cache, connection).collect { useCase.flushIfReady(cache, connection.value.status) } }
        cache.enqueue("p1", "first")
        runCurrent()
        assertTrue(repo.sent.isEmpty())
        authority.value = "draft"
        runCurrent()
        assertEquals(listOf("first" to "p1"), repo.sent)
        authority.value = "minted"
        cache.enqueue("p2", "second")
        runCurrent()
        assertEquals(listOf("first" to "p1", "second" to "p2"), repo.sent)
        transport.value += 1
        runCurrent()
        assertEquals(listOf("p1", "p2", "p1", "p2"), repo.sent.map { it.second })
        epoch.value = 2
        cache.enqueue("stale", "stale")
        runCurrent()
        assertEquals(4, repo.sent.size)
    }


    @Test
    fun queued_entries_drain_only_when_ready() {
        val repo = CapturingConversationRepository()
        val cache = cacheForRoute(1)
        cache.enqueue("p1", "hello")
        cache.enqueue("p2", "world")

        sendUseCase(repo, MutableStateFlow("existing-conv")).flushIfReady(cache, SdkStatus.READY)

        assertEquals(listOf("hello" to "p1", "world" to "p2"), repo.sent)
        assertEquals(2, cache.queued().size, "sent-but-unechoed entries remain in queued() for reconnect re-send")
    }

    @Test
    fun non_ready_status_is_a_no_op() {
        val repo = CapturingConversationRepository()
        val cache = cacheForRoute(1)
        cache.enqueue("p1", "hello")

        sendUseCase(repo, MutableStateFlow("existing-conv")).flushIfReady(cache, SdkStatus.RECONNECTING)

        assertTrue(repo.sent.isEmpty(), "no send while not READY")
        assertEquals(1, cache.queued().size, "entry stays QUEUED for the next rising edge")
    }

    @Test
    fun sent_entries_are_resent_on_reconnect_because_gateway_dedups_by_pendingId() {
        val repo = CapturingConversationRepository()
        val cache = cacheForRoute(1)
        cache.enqueue("p1", "hello")
        val transport = MutableStateFlow(0L)
        val useCase = sendUseCase(repo, MutableStateFlow("existing-conv"), transportGeneration = transport)

        useCase.flushIfReady(cache, SdkStatus.READY)
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(1, repo.sent.size, "READY emissions are not new transport attempts")
        transport.value += 1 // even if a collector missed the transient non-READY state
        useCase.flushIfReady(cache, SdkStatus.READY)

        assertEquals(2, repo.sent.size, "a sent-but-unechoed entry IS re-sent on reconnect (gateway dedups)")
        assertEquals(MessageStatus.QUEUED, cache.pending.value.single().status)
    }

    @Test
    fun stale_B_cache_cannot_send_on_A_or_a_later_B_route() {
        val repo = CapturingConversationRepository()
        val authorizedId = MutableStateFlow<String?>("B")
        val activeRoute = MutableStateFlow<Long?>(1)
        val oldB = cacheForRoute(1).apply { enqueue("old-B", "for old B") }
        val useCase = sendUseCase(repo, authorizedId, activeRoute)

        activeRoute.value = 2
        authorizedId.value = "A"
        useCase.flushIfReady(oldB, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "old B cache must not use A authority")

        val currentB = cacheForRoute(3).apply { enqueue("current-B", "for current B") }
        activeRoute.value = 3
        authorizedId.value = "B"
        useCase.flushIfReady(oldB, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "returning to B must not revive old B cache")

        useCase.flushIfReady(currentB, SdkStatus.READY)
        assertEquals(listOf("for current B" to "current-B"), repo.sent)
    }

    @Test
    fun failed_switch_holds_target_cache_until_that_route_is_acknowledged() {
        val repo = CapturingConversationRepository()
        val authorizedId = MutableStateFlow<String?>(null)
        val cache = cacheForRoute(2).apply { enqueue("pending-B", "for B") }
        val useCase = sendUseCase(repo, authorizedId, MutableStateFlow(2))

        useCase.flushIfReady(cache, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "failed B activation stays fenced")

        authorizedId.value = "B"
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(listOf("for B" to "pending-B"), repo.sent)
    }

    @Test
    fun fresh_route_waits_for_draft_and_keeps_generation_through_initial_mint() {
        val repo = CapturingConversationRepository()
        val authorizedId = MutableStateFlow<String?>(null)
        val cache = cacheForRoute(4).apply { enqueue("p1", "hello") }
        val useCase = sendUseCase(repo, authorizedId, MutableStateFlow(4))

        useCase.flushIfReady(cache, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "fresh route has no outbound authority before draft")

        authorizedId.value = "draft-1"
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(listOf("hello" to "p1"), repo.sent)

        authorizedId.value = "session-1"
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(1, repo.sent.size, "draft to mint is not a reconnect and must not resend")
        assertEquals(setOf("p1"), repo.sent.map { it.second }.toSet())
    }

    @Test
    fun does_not_flush_until_a_session_id_is_attached() {
        val repo = CapturingConversationRepository()
        val authorizedId = MutableStateFlow<String?>(null)
        val cache = cacheForRoute(1)
        cache.enqueue("p1", "hello")
        val useCase = sendUseCase(repo, authorizedId)

        useCase.flushIfReady(cache, SdkStatus.READY)
        assertTrue(repo.sent.isEmpty(), "gated: READY but no conversation id attached")
        assertEquals(1, cache.queued().size, "entry stays QUEUED while id is unattached")

        authorizedId.value = "conv-Y"
        useCase.flushIfReady(cache, SdkStatus.READY)
        assertEquals(listOf("hello" to "p1"), repo.sent, "flushes once conversation id is attached")
    }
}
