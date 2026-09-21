package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.sdk.AssistantActivityPhase
import io.sentient.mobilesdk.sdk.AssistantActivityState
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
    val tasksState = MutableStateFlow<List<TaskListItem>>(emptyList())
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val tasks: StateFlow<List<TaskListItem>> = tasksState
    override val liveEvents: SharedFlow<SdkEvent> = events
    override val echoedPendingIds: kotlinx.coroutines.flow.Flow<Set<String>> = echoed
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String, attachmentIds: List<String>) { sent.add(text to pendingId) }
}

class ObserveChatUseCaseTest {

    private fun useCase(repo: ConversationRepository) = ObserveChatUseCase(repo, clock = Clock { 0L })

    @Test
    fun committed_twin_suppressed_while_live_same_turn() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "Hello", turnId = "c1", replyId = "r1"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("c1", replyId = "r1"))
        repo.events.emit(SdkEvent.MessageDelta("c1", "Hello", replyId = "r1"))
        runCurrent()
        val m = models.last()
        assertEquals(1, m.committed.size)          // user only; assistant r1 suppressed by live bubble
        assertEquals("user", m.committed[0].role)
        assertEquals("c1", m.live?.turnId)
        job.cancel()
    }

    @Test
    fun a_committed_row_of_another_reply_is_never_suppressed() = runTest(UnconfinedTestDispatcher()) {
        // The old predicate fell back to turn-matching whenever EITHER side
        // lacked a key, so a row from the same turn but a different reply
        // vanished behind the live bubble. Keyed on the reply alone, it cannot.
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "first stretch", turnId = "t1", replyId = "r1"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        // Live bubble is a DIFFERENT reply of the SAME turn — a mid-turn steer
        // rotated the reply id while the turn id stayed put.
        repo.events.emit(SdkEvent.MessageStarted("t1", replyId = "r2"))
        repo.events.emit(SdkEvent.MessageDelta("t1", "second stretch", replyId = "r2"))
        runCurrent()
        val m = models.last()
        assertTrue(
            m.committed.any { it.replyId == "r1" && it.content == "first stretch" },
            "the r1 row must stay visible — only r2 (the live bubble's own reply) is suppressed",
        )
        assertEquals("r2", m.live?.replyId)
        job.cancel()
    }

    @Test
    fun a_keyless_row_of_the_live_turn_is_not_suppressed() = runTest(UnconfinedTestDispatcher()) {
        // THE discriminating case — the reported bug's exact shape. A committed
        // row that has no replyId at all (a user row, a tool tile, or an entry
        // written before the column existed) but DOES share the live bubble's
        // turnId. The retired predicate's sameTurn fallback fired whenever
        // EITHER side lacked a key, so this row matched on turnId alone and
        // vanished for the whole reveal even though its replyId never matched
        // (it has none). Reply-only matching cannot fall back to the turn, so
        // this row must stay visible.
        //
        // (a_committed_row_of_another_reply_is_never_suppressed above does NOT
        // exercise this: both its sides carry a key, which the retired
        // predicate already got right — see the review that caught this gap.)
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "hi"),
            ChatMessage(ts = 2, role = "assistant", content = "keyless", turnId = "t1", replyId = null),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        repo.events.emit(SdkEvent.MessageStarted("t1", replyId = "r1"))
        repo.events.emit(SdkEvent.MessageDelta("t1", "live text", replyId = "r1"))
        runCurrent()
        val m = models.last()
        assertTrue(
            m.committed.any { it.replyId == null && it.content == "keyless" },
            "a keyless row sharing the bubble's turn must stay visible — only an exact replyId match is hidden",
        )
        assertEquals("r1", m.live?.replyId)
        job.cancel()
    }

    @Test
    fun activity_identity_is_projected_with_live_row_without_latestRow_guessing() = runTest(UnconfinedTestDispatcher()) {
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "assistant", content = "old", turnId = "t1", replyId = "r1"),
        )
        val activity = MutableStateFlow(AssistantActivityState())
        val models = mutableListOf<ChatModel>()
        val observe = ObserveChatUseCase(repo, Clock { 0L }, activity)
        val job = launch { observe(MutableStateFlow(emptyList())).collect { models.add(it) } }

        repo.events.emit(SdkEvent.MessageStarted("t2"))
        activity.value = AssistantActivityState(AssistantActivityPhase.THINKING, "t2", null)
        runCurrent()

        assertEquals("t2", models.last().live?.turnId)
        assertEquals("t2", models.last().assistantActivity.turnId)
        assertTrue(models.last().committed.any { it.replyId == "r1" }, "historical row stays unrelated")
        job.cancel()
    }

    @Test
    fun turn_seed_identity_and_timestamp_survive_reply_adoption_and_committed_echo() =
        runTest(UnconfinedTestDispatcher()) {
            val repo = FakeConversationRepository()
            var now = 59_500L
            val models = mutableListOf<ChatModel>()
            val observe = ObserveChatUseCase(repo, Clock { now })
            val job = launch { observe(MutableStateFlow(emptyList())).collect { models.add(it) } }

            // Actual wire-derived event order: turn.started has no reply id; first
            // text delta stamps it and adopts the seeded placeholder.
            repo.events.emit(SdkEvent.MessageStarted("t1"))
            runCurrent()
            val seed = models.last().live!!
            assertEquals(59_500L, seed.ts)
            assertEquals("presentation:turn:t1", seed.entryId)

            now = 60_500L
            repo.events.emit(SdkEvent.MessageDelta("t1", "x", replyId = "r1"))
            runCurrent()
            assertEquals(seed.ts, models.last().live?.ts)
            assertEquals(seed.entryId, models.last().live?.entryId)
            assertEquals("r1", models.last().live?.replyId)

            now = 61_500L
            repo.events.emit(SdkEvent.MessageDelta("t1", "y", replyId = "r1"))
            runCurrent()
            assertEquals(seed.ts, models.last().live?.ts)
            assertEquals(seed.entryId, models.last().live?.entryId)

            now = 62_500L
            val committed = ChatMessage(
                ts = now, role = "assistant", content = "xy", turnId = "t1", replyId = "r1",
                entryId = "gateway-entry",
            )
            repo.timelineState.value = listOf(committed)
            repo.events.emit(SdkEvent.MessageCommitted(committed))
            runCurrent()
            advanceTimeBy(16)
            runCurrent()
            now = 63_500L
            advanceTimeBy(16)
            runCurrent()

            val echo = models.last().committed.single()
            assertNull(models.last().live)
            assertEquals(seed.ts, echo.ts)
            assertEquals(seed.entryId, echo.entryId)
            job.cancel()
        }

    @Test
    fun zero_delta_failure_keeps_seed_identity_through_stamped_entry_and_completion() =
        runTest(UnconfinedTestDispatcher()) {
            val repo = FakeConversationRepository()
            var now = 100L
            val models = mutableListOf<ChatModel>()
            val observe = ObserveChatUseCase(repo, Clock { now })
            val job = launch { observe(MutableStateFlow(emptyList())).collect { models.add(it) } }

            repo.events.emit(SdkEvent.MessageStarted("t1"))
            runCurrent()
            val seed = models.last().live!!

            now = 200L
            repo.events.emit(SdkEvent.MessageStarted("t1", replyId = "r1"))
            val committed = ChatMessage(
                ts = now,
                role = "assistant",
                content = "Something went wrong",
                turnId = "t1",
                replyId = "r1",
                entryId = "gateway-entry",
            )
            repo.timelineState.value = listOf(committed)
            runCurrent()
            assertEquals(seed.ts, models.last().live?.ts)
            assertEquals(seed.entryId, models.last().live?.entryId)
            assertTrue(models.last().committed.isEmpty(), "stamped live twin suppresses only r1")

            repo.events.emit(SdkEvent.MessageCommitted(committed))
            advanceTimeBy(16)
            runCurrent()
            val completed = models.last().committed.single()
            assertNull(models.last().live)
            assertEquals(seed.ts, completed.ts)
            assertEquals(seed.entryId, completed.entryId)
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
    fun equivalent_reveal_ticks_are_suppressed_but_presentation_changes_emit() =
        runTest(UnconfinedTestDispatcher()) {
            val repo = FakeConversationRepository()
            var now = 1_000L
            val activity = MutableStateFlow(AssistantActivityState())
            val models = mutableListOf<ChatModel>()
            val observe = ObserveChatUseCase(repo, Clock { now }, activity)
            val job = launch { observe(MutableStateFlow(emptyList())).collect { models.add(it) } }

            repo.events.emit(SdkEvent.MessageStarted("thinking"))
            runCurrent()
            val afterStart = models.size

            // RevealReducer still advances its hidden ticker state, but no visible field changed.
            now += 16
            advanceTimeBy(16)
            runCurrent()
            assertEquals(afterStart, models.size)

            activity.value = AssistantActivityState(AssistantActivityPhase.THINKING, "thinking", null)
            runCurrent()
            assertEquals(afterStart + 1, models.size)
            assertEquals("", models.last().live?.content)

            repo.tasksState.value = listOf(TaskListItem(id = "task", toolName = "search", status = "running"))
            runCurrent()
            assertEquals(afterStart + 2, models.size)

            repo.timelineState.value = listOf(ChatMessage(ts = 1, role = "user", content = "committed"))
            runCurrent()
            assertEquals(afterStart + 3, models.size)
            job.cancel()
        }

    @Test
    fun token_delta_is_retained_until_ticker_makes_content_visible() =
        runTest(UnconfinedTestDispatcher()) {
            val repo = FakeConversationRepository()
            var now = 1_000L
            val models = mutableListOf<ChatModel>()
            val observe = ObserveChatUseCase(repo, Clock { now })
            val job = launch { observe(MutableStateFlow(emptyList())).collect { models.add(it) } }

            repo.events.emit(SdkEvent.MessageStarted("turn"))
            repo.events.emit(SdkEvent.MessageDelta("turn", "abcdefghij"))
            runCurrent()
            val beforeTicks = models.size

            now = 1_000L
            advanceTimeBy(16)
            runCurrent()
            assertEquals(beforeTicks, models.size, "first zero-progress tick is presentation-equivalent")

            now = 1_100L
            advanceTimeBy(16)
            runCurrent()
            assertTrue(models.size > beforeTicks)
            assertTrue(models.last().live?.content?.isNotEmpty() == true)
            job.cancel()
        }

    @Test
    fun prior_turn_is_not_suppressed_when_live_turn_differs() = runTest(UnconfinedTestDispatcher()) {
        // With unique replyIds, the live bubble's id never matches a PRIOR turn's
        // reply, so the suppression filter drops only the live bubble's committed
        // twin. (Under the old reused-"cycle-1" bug, the prior turn's reply was
        // wrongly suppressed.)
        val repo = FakeConversationRepository()
        repo.timelineState.value = listOf(
            ChatMessage(ts = 1, role = "user", content = "q1"),
            // prior turn
            ChatMessage(ts = 2, role = "assistant", content = "answer-1", turnId = "1000", replyId = "1000"),
            ChatMessage(ts = 3, role = "user", content = "q2"),
        )
        val models = mutableListOf<ChatModel>()
        val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
        // live = a DIFFERENT (later) turn/reply
        repo.events.emit(SdkEvent.MessageStarted("2000", replyId = "2000"))
        repo.events.emit(SdkEvent.MessageDelta("2000", "answer-2", replyId = "2000"))
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
