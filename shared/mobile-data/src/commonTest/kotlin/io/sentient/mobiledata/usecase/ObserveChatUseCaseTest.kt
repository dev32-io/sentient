package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.OutboundCache
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
    // The LIVE-echo reconcile source: pendingIds seen on committed user entries of the
    // SDK's OWN (pre-strip) timeline. Driven directly by tests to simulate the echo, since
    // the DB-backed timeline strips pendingId (so committed.pendingId can no longer carry it).
    val echoed = MutableStateFlow<Set<String>>(emptySet())
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val liveEvents: SharedFlow<SdkEvent> = events
    override val echoedPendingIds: kotlinx.coroutines.flow.Flow<Set<String>> = echoed
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class ObserveChatUseCaseTest {

    private fun useCase(repo: ConversationRepository) = ObserveChatUseCase(repo, clock = Clock { 0L })

    @Test
    fun committed_twin_suppressed_while_live_same_turn() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "Hello", turnId = "c1"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("c1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "Hello"))
        runCurrent()
        val m = models.last()
        assertEquals(1, m.committed.size)          // user only; assistant c1 suppressed by live bubble
        assertEquals("user", m.committed[0].role)
        assertEquals("c1", m.live?.turnId)
        job.cancel()
    }

    @Test
    fun pending_reconciled_by_live_echo() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        // The committed user entry carries pendingId on the SDK's own timeline; the echo
        // is surfaced via echoedPendingIds (the reconcile source).
        repo.timelineState.value = listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = "p1"))
        repo.echoed.value = setOf("p1")
        val pending = MutableStateFlow(listOf(PendingMessage("p1", "hi", MessageStatus.QUEUED, sentAtMs = 1L)))
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(pending).collect { models.add(it) } }
        runCurrent()
        val m = models.last()
        assertTrue(m.pending.isEmpty(), "live echo with same pendingId reconciles the optimistic bubble")
        assertTrue("p1" in m.reconciledPendingIds, "the reconciled id is surfaced for the VM's cache.remove")
        assertEquals(1, m.committed.size)
        job.cancel()
    }

    @Test
    fun pending_dropped_on_live_echo_even_when_committed_entry_has_no_pendingId() =
        runTest(UnconfinedTestDispatcher()) {
            // REGRESSION (Slice 4 DB mirror): the DB-backed timeline STRIPS pendingId, so the
            // committed user entry the VM sees has pendingId=null. Reconcile must still fire,
            // driven by the LIVE echo set — NOT committed.pendingId.
            val repo = FakeConversationRepository()
            repo.timelineState.value =
                listOf(ChatMessage(ts = 1, role = "user", content = "hi", pendingId = null))
            repo.echoed.value = setOf("p1") // the live echo carries the pendingId the DB row dropped
            val pending = MutableStateFlow(listOf(PendingMessage("p1", "hi", MessageStatus.QUEUED, sentAtMs = 1L)))
            val models = mutableListOf<ChatModel>()
            val job = launch { useCase(repo).invoke(pending).collect { models.add(it) } }
            runCurrent()
            val m = models.last()
            assertTrue(
                m.pending.isEmpty(),
                "optimistic bubble dropped on live echo despite the DB-stripped committed pendingId",
            )
            assertEquals(1, m.committed.size, "exactly one user bubble remains (the committed twin)")
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

    @Test
    fun existing_switch_sets_history_loading_until_snapshot() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        runCurrent()
        assertTrue(!models.last().historyLoading, "no loading before any switch")

        repo.events.emit(SdkEvent.SessionSwitched("s2")) // non-empty id ⇒ existing-session switch
        runCurrent()
        assertTrue(models.last().historyLoading, "switch starts loading, awaiting snapshot")

        // conversation.snapshot REPLACES the timeline ⇒ a timeline emission.
        repo.timelineState.value = listOf(ChatMessage(ts = 1, role = "user", content = "old"))
        runCurrent()
        assertTrue(!models.last().historyLoading, "snapshot clears loading")
        job.cancel()
    }

    @Test
    fun `cold history replace drops still-pending optimistic entries from cold REST history`() =
        runTest(UnconfinedTestDispatcher()) {
            // A COLD REST history snapshot (recovered:false refetch / existing-switch reload)
            // carries NO pendingId, so reconcile-by-pendingId can't drop the optimistic bubble:
            // the authoritative "hello" lands as a committed entry with pendingId=null while the
            // optimistic "hello" stays in the cache → a DUPLICATE bubble. onColdHistoryReplace
            // drops every still-present optimistic entry (now in the authoritative history, or
            // already swept to FAILED by the unacked-timeout) so a single committed bubble remains.
            val cache = OutboundCache().apply {
                enqueue("p1", "hello")
                markSent("p1") // sent-but-unechoed: still in cache.pending, no echo will carry p1
            }
            val repo = FakeConversationRepository()
            useCase(repo).onColdHistoryReplace(cache)
            assertTrue(
                cache.pending.value.none { it.id == "p1" },
                "cold replace drops the optimistic entry → single committed bubble",
            )
        }

    @Test
    fun new_chat_never_shows_history_loading() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        runCurrent()

        // session.new → gateway emits session.switched("") + empty immediate snapshot.
        repo.events.emit(SdkEvent.SessionSwitched(""))
        repo.timelineState.value = emptyList()
        runCurrent()
        assertTrue(models.none { it.historyLoading }, "empty-id switch never raises the spinner")
        job.cancel()
    }

    @Test
    fun prior_turn_is_not_suppressed_when_live_turn_differs() = runTest(UnconfinedTestDispatcher()) {
        // With unique turnIds, the live turn's id never matches a PRIOR turn's id,
        // so the suppression filter drops only the live turn's committed twin. (Under
        // the old reused-"cycle-1" bug, the prior turn's reply was wrongly suppressed.)
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "q1"),
            ChatMessage(ts = 2, role = "assistant", content = "answer-1", turnId = "1000"), // prior turn
            ChatMessage(ts = 3, role = "user", content = "q2"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("2000")) // live = a DIFFERENT (later) turn
        repo.events.emit(SdkEvent.MessageDelta("2000", "answer-2"))
        runCurrent()
        val m = models.last()
        assertTrue(
            m.committed.any { it.turnId == "1000" && it.content == "answer-1" },
            "the prior turn's reply must stay visible — only the live turn (2000) is suppressed",
        )
        assertEquals("2000", m.live?.turnId)
        job.cancel()
    }
}
