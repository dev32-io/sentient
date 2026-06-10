// ---------------------------------------------------------------------------
// CachingConversationRepositoryTest — pins the write-through + delete-on-switch
// decorator against a REAL in-memory SQLite DB on the JVM host (androidUnitTest).
//
// The decorator wraps a ConversationRepository (here a fake emitting the SDK's
// fused timeline + liveEvents) and:
//   • exposes a DB-BACKED timeline (instant-paint-on-launch from persisted rows),
//   • writes COMMITTED (non-empty entryId) timeline entries through to the DB,
//   • on SessionSwitched(nonEmpty) deletes the conversation's rows (replace-on-
//     reload) so the incoming REST/live set repopulates fresh.
//
// These cover the matrix from the Task 4.5 brief: write-through, in-flight skip,
// replace-on-reload (delete-then-repopulate, not merge), namespace independence
// (live UUID + positional REST entries coexist), and seq ordering.
//
// The decorator's collectors + DB-backed stateIn are launched on backgroundScope
// (auto-cancelled at test end) and pinned to the test scheduler via an
// UnconfinedTestDispatcher, so the real SQLDelight query notifier runs on the
// virtual clock and runCurrent() deterministically flushes write-through + reads.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data

import io.sentient.mobiledata.cache.db.ChatDatabase
import io.sentient.mobiledata.cache.db.InMemoryDatabaseDriverFactory
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeUnderlyingRepository : ConversationRepository {
    val timelineState = MutableStateFlow<List<ChatMessage>>(emptyList())
    val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val liveEvents: SharedFlow<SdkEvent> = events
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class CachingConversationRepositoryTest {

    private val driver = InMemoryDatabaseDriverFactory().create()
    private val db = ChatDatabase(driver)

    @AfterTest
    fun tearDown() = driver.close()

    /**
     * Build the decorator on the test scheduler so its DB query notifier is deterministic.
     * The SAME test dispatcher backs both the read query mapping AND the write seam
     * (ioDispatcher), so SQLite writes stay on the virtual scheduler — runCurrent()
     * deterministically flushes delete-on-switch + write-through.
     */
    private fun TestScope.repoFor(under: ConversationRepository): CachingConversationRepository {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        return CachingConversationRepository(
            under, db, scope = backgroundScope, dispatcher = dispatcher, ioDispatcher = dispatcher,
        )
    }

    private fun committed(entryId: String, content: String) =
        ChatMessage(ts = 0, role = "assistant", content = content, entryId = entryId)

    private fun rows(conv: String) = db.chatDatabaseQueries.messagesFor(conv).executeAsList()

    @Test
    fun `committed entry in the SDK timeline is persisted and visible in the DB-backed timeline`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(committed("e1", "hello"))
            runCurrent()

            val persisted = rows("conv-1")
            assertEquals(1, persisted.size)
            assertEquals("e1", persisted.single().entry_id)
            assertEquals("hello", persisted.single().content)

            val painted = repo.timeline.value
            assertEquals(1, painted.size)
            assertEquals("e1", painted.single().entryId)
        }

    @Test
    fun `an in-flight entry with empty entryId is NOT persisted`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            repoFor(under) // started for its collectors; this test asserts against the DB, not the decorator

            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(
                committed("e1", "committed"),
                ChatMessage(ts = 1, role = "assistant", content = "streaming…", streaming = true),
            )
            runCurrent()

            val persisted = rows("conv-1")
            assertEquals(1, persisted.size) // only the committed one; the empty-entryId bubble skipped
            assertEquals("e1", persisted.single().entry_id)
        }

    @Test
    fun `in-flight entry is persisted once it GAINS an entryId`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            repoFor(under) // started for its collectors; this test asserts against the DB, not the decorator

            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value =
                listOf(ChatMessage(ts = 0, role = "assistant", content = "draft", streaming = true))
            runCurrent()
            assertTrue(rows("conv-1").isEmpty())

            under.timelineState.value = listOf(committed("e9", "draft")) // now committed
            runCurrent()
            val persisted = rows("conv-1")
            assertEquals(1, persisted.size)
            assertEquals("e9", persisted.single().entry_id)
        }

    @Test
    fun `replace-on-reload deletes stale rows on switch then repopulates from the new set`() =
        runTest(UnconfinedTestDispatcher()) {
            // Seed a STALE row directly (as if from a prior session reload).
            db.chatDatabaseQueries.upsertMessage(
                entry_id = "conv-1:99", conversation_id = "conv-1", seq = 99,
                role = "assistant", content = "STALE", ts = 99, cutoff_kind = null,
            )
            val under = FakeUnderlyingRepository()
            repoFor(under) // started for its collectors; this test asserts against the DB, not the decorator

            // Switch INTO conv-1 → clears stale rows, then the REST set repopulates.
            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(committed("conv-1:0", "fresh-0"), committed("conv-1:1", "fresh-1"))
            runCurrent()

            val persisted = rows("conv-1")
            assertEquals(2, persisted.size) // stale-99 gone, only the new positional set
            assertNull(persisted.firstOrNull { it.entry_id == "conv-1:99" })
            assertEquals(listOf("conv-1:0", "conv-1:1"), persisted.map { it.entry_id })
        }

    @Test
    fun `namespace independence — a live UUID entry coexists with positional REST entries`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            repoFor(under) // started for its collectors; this test asserts against the DB, not the decorator

            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(
                committed("conv-1:0", "rest-0"),
                committed("conv-1:1", "rest-1"),
                committed("550e8400-e29b-41d4-a716-446655440000", "live"),
            )
            runCurrent()

            val persisted = rows("conv-1")
            assertEquals(3, persisted.size)
            assertEquals(
                listOf("conv-1:0", "conv-1:1", "550e8400-e29b-41d4-a716-446655440000"),
                persisted.map { it.entry_id },
            )
        }

    @Test
    fun `DB-backed timeline is ordered by seq position`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(
                committed("e0", "first"),
                committed("e1", "second"),
                committed("e2", "third"),
            )
            runCurrent()

            val painted = repo.timeline.value
            assertEquals(listOf("first", "second", "third"), painted.map { it.content })
            assertEquals(listOf("e0", "e1", "e2"), painted.map { it.entryId })
        }

    @Test
    fun `send and liveEvents pass through to the underlying repository`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            repo.send("hi", "p1")
            assertEquals(listOf("hi" to "p1"), under.sent)

            val seen = mutableListOf<SdkEvent>()
            backgroundScope.launch { repo.liveEvents.collect { seen.add(it) } }
            runCurrent()
            under.events.emit(SdkEvent.CycleDone("c1"))
            runCurrent()
            assertEquals(SdkEvent.CycleDone("c1"), seen.single())
        }

}
