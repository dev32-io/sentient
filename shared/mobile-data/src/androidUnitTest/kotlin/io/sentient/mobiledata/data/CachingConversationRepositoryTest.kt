// ---------------------------------------------------------------------------
// CachingConversationRepositoryTest — pins the client-intent anchor + write-through
// + atomic-replace decorator against a REAL in-memory SQLite DB on the JVM host
// (androidUnitTest).
//
// The decorator wraps a ConversationRepository (here a fake emitting the SDK's
// fused timeline + liveEvents) and:
//   • exposes a DB-BACKED timeline anchored on the CLIENT-INTENT signal — the cached
//     rows paint INSTANTLY from the client's switch intent, with NO server echo
//     required (cold-start case),
//   • writes COMMITTED (non-empty entryId) timeline entries through to the DB,
//   • on SessionSwitched(nonEmpty) arms a one-shot ATOMIC replace: the next timeline
//     snapshot runs delete+insert in a single transaction (replace-on-reload) so the
//     reactive flow emits cached→REST with NO empty intermediate.
//
// These cover the matrix from the Task 4.5 brief PLUS the cold-start instant-paint:
// client-intent paint (no echo), atomic replace (no empty flash), write-through,
// in-flight skip, namespace independence (live UUID + positional REST entries
// coexist), and seq ordering.
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeUnderlyingRepository : ConversationRepository {
    val timelineState = MutableStateFlow<List<ChatMessage>>(emptyList())
    val events = MutableSharedFlow<SdkEvent>(extraBufferCapacity = 64)
    override val timeline: StateFlow<List<ChatMessage>> = timelineState
    override val liveEvents: SharedFlow<SdkEvent> = events
    // Mirror the real SdkConversationRepository derivation: the underlying (pre-strip)
    // timeline's committed pendingIds, accumulated. The decorator delegates echoedPendingIds
    // straight through to this, surfacing the echo BEFORE the DB mapping strips it.
    override val echoedPendingIds: kotlinx.coroutines.flow.Flow<Set<String>> =
        timelineState.scan(emptySet()) { acc, list -> acc + list.mapNotNull { it.pendingId } }
    val sent = mutableListOf<Pair<String, String>>()
    override fun send(text: String, pendingId: String) { sent.add(text to pendingId) }
}

class CachingConversationRepositoryTest {

    private val driver = InMemoryDatabaseDriverFactory().create()
    private val db = ChatDatabase(driver)

    // The shared CLIENT-INTENT anchor, owned in production by ChatComponent and SET by
    // the sessions decorator's switch path. Here the test drives it directly to simulate
    // the client's switch intent (route open) — independent of any server echo.
    private val intent = MutableStateFlow<String?>(null)

    @AfterTest
    fun tearDown() = driver.close()

    /**
     * Build the decorator on the test scheduler so its DB query notifier is deterministic.
     * The SAME test dispatcher backs both the read query mapping AND the write seam
     * (ioDispatcher), so SQLite writes stay on the virtual scheduler — runCurrent()
     * deterministically flushes the atomic replace + write-through.
     */
    private fun TestScope.repoFor(under: ConversationRepository): CachingConversationRepository {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        return CachingConversationRepository(
            under,
            db,
            scope = backgroundScope,
            activeConversationIntent = intent,
            dispatcher = dispatcher,
            ioDispatcher = dispatcher,
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

            intent.value = "conv-1" // client switch intent anchors the paint + write-through
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

            intent.value = "conv-1" // client switch intent
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

            intent.value = "conv-1" // client switch intent
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

            // Client anchors conv-1; the live echo arms the atomic replace; the REST
            // snapshot then deletes the stale row + inserts the new set in one transaction.
            intent.value = "conv-1"
            under.events.emit(SdkEvent.SessionSwitched("conv-1"))
            under.timelineState.value = listOf(committed("conv-1:0", "fresh-0"), committed("conv-1:1", "fresh-1"))
            runCurrent()

            val persisted = rows("conv-1")
            assertEquals(2, persisted.size) // stale-99 gone, only the new positional set
            assertNull(persisted.firstOrNull { it.entry_id == "conv-1:99" })
            assertEquals(listOf("conv-1:0", "conv-1:1"), persisted.map { it.entry_id })
        }

    @Test
    fun `COLD start — cached rows paint instantly from client intent with NO server echo`() =
        runTest(UnconfinedTestDispatcher()) {
            // Seed conv-X's persisted rows directly (as if from a prior launch's reload).
            db.chatDatabaseQueries.upsertMessage(
                entry_id = "conv-X:0", conversation_id = "conv-X", seq = 0,
                role = "user", content = "cached-0", ts = 0, cutoff_kind = null,
            )
            db.chatDatabaseQueries.upsertMessage(
                entry_id = "conv-X:1", conversation_id = "conv-X", seq = 1,
                role = "assistant", content = "cached-1", ts = 1, cutoff_kind = null,
            )
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            // Client switch intent ONLY — no SessionSwitched echo, no SDK timeline. The
            // DB-backed timeline must paint the cached rows immediately.
            intent.value = "conv-X"
            runCurrent()

            val painted = repo.timeline.value
            assertEquals(listOf("cached-0", "cached-1"), painted.map { it.content })
            assertEquals(listOf("conv-X:0", "conv-X:1"), painted.map { it.entryId })
        }

    @Test
    fun `atomic replace — cached paint never flashes to empty before the REST set lands`() =
        runTest(UnconfinedTestDispatcher()) {
            // Cold cached baseline for conv-X.
            db.chatDatabaseQueries.upsertMessage(
                entry_id = "conv-X:0", conversation_id = "conv-X", seq = 0,
                role = "user", content = "cached", ts = 0, cutoff_kind = null,
            )
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            // Collect EVERY emission of the painted timeline so we can prove no empty
            // intermediate slips between the cached set and the REST set.
            val emissions = mutableListOf<List<String>>()
            backgroundScope.launch { repo.timeline.collect { emissions.add(it.map { m -> m.content }) } }

            intent.value = "conv-X" // paints the cached row
            runCurrent()
            assertEquals(listOf("cached"), repo.timeline.value.map { it.content })

            // Live echo arms the replace. The SDK switch passes through an EMPTY
            // intermediate snapshot (replaceMirror(emptyList()) while awaiting REST) —
            // the delete must NOT fire here, or the cached rows would flash to empty.
            under.events.emit(SdkEvent.SessionSwitched("conv-X"))
            under.timelineState.value = emptyList()
            runCurrent()
            assertEquals(listOf("cached"), repo.timeline.value.map { it.content }) // survives the empty window

            // The REST reload (different positional set) then arrives → atomic
            // delete+insert in ONE transaction, cached → REST with no empty between.
            under.timelineState.value = listOf(committed("conv-X:0", "rest-0"), committed("conv-X:1", "rest-1"))
            runCurrent()

            assertEquals(listOf("rest-0", "rest-1"), repo.timeline.value.map { it.content })
            // The atomic transaction guarantees the reactive flow never emitted emptyList
            // ONCE the cached set had painted. (The leading empty is the pre-anchor
            // initial value of the Eagerly stateIn — not a flash.) From the first
            // non-empty emission onward there must be NO empty: cached → REST, no gap.
            val firstPainted = emissions.indexOfFirst { it.isNotEmpty() }
            assertTrue(firstPainted >= 0, "timeline never painted: $emissions")
            assertFalse(
                emissions.drop(firstPainted).any { it.isEmpty() },
                "timeline flashed to empty during replace: $emissions",
            )
        }

    @Test
    fun `namespace independence — a live UUID entry coexists with positional REST entries`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeUnderlyingRepository()
            repoFor(under) // started for its collectors; this test asserts against the DB, not the decorator

            intent.value = "conv-1" // client switch intent
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

            intent.value = "conv-1" // client switch intent
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
    fun `REGRESSION new chat — committed reply is DROPPED on null anchor, LANDS after re-anchor to the minted id`() =
        runTest(UnconfinedTestDispatcher()) {
            // A NEW chat: no client switchTo ran, so the shared client-intent anchor
            // is null (this is exactly ChatComponent's state before the VM re-remembers).
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)
            assertNull(intent.value, "precondition: a new chat has no client switch intent yet")

            // The user's first message + the live assistant stream flow over the SDK
            // timeline while the anchor is still null (the optimistic outbox + live
            // bubble — untouched by this fix — carry the UI here). The streaming bubble
            // has an EMPTY entryId; write-through skips it AND the DB timeline is
            // messagesFor(null) = emptyList — nothing persists. This is correct so far.
            val mintedId = "minted-conv-1"
            under.timelineState.value = listOf(
                ChatMessage(ts = 0, role = "user", content = "first question", entryId = "u1"),
                ChatMessage(ts = 1, role = "assistant", content = "streaming…", streaming = true),
            )
            runCurrent()
            assertTrue(rows(mintedId).isEmpty(), "nothing persists under the minted id while the anchor is null")
            assertTrue(repo.timeline.value.isEmpty(), "DB-backed timeline is empty while the anchor is null")

            // session.created lands FIRST in the cycle → the SDK anchors currentSessionId
            // → the VM re-remembers the minted id (ChatComponent.rememberActiveConversation
            // sets THIS same intent). Re-anchoring re-subscribes the DB timeline to
            // messagesFor(mintedId).
            intent.value = mintedId
            runCurrent()

            // THEN the assistant reply COMMITS — a distinct SDK timeline snapshot. With
            // the anchor now set, write-through persists the committed entries under the
            // minted id. WITHOUT the re-anchor fix this snapshot would early-return on the
            // null anchor and the committed reply would be dropped — the exact regression.
            under.timelineState.value = listOf(
                ChatMessage(ts = 0, role = "user", content = "first question", entryId = "u1"),
                committed("e1", "the answer that must not be dropped"),
            )
            runCurrent()

            // AFTER the re-anchor: the committed user message + assistant reply are both
            // persisted under the minted id AND paint in the DB-backed timeline.
            val persisted = rows(mintedId)
            assertEquals(listOf("u1", "e1"), persisted.map { it.entry_id })
            assertEquals(
                "the answer that must not be dropped",
                persisted.single { it.entry_id == "e1" }.content,
            )

            val painted = repo.timeline.value
            assertEquals(listOf("u1", "e1"), painted.map { it.entryId })
            assertEquals(
                "the answer that must not be dropped",
                painted.single { it.entryId == "e1" }.content,
            )
        }

    @Test
    fun `REGRESSION optimistic send — DB mirror STRIPS pendingId but the live echo still reconciles`() =
        runTest(UnconfinedTestDispatcher()) {
            // The exact Slice-4 bug: the durable mirror persists entry_id but DROPS pendingId
            // (the reconcile key), so the DB-backed timeline the VM sees has pendingId=null and
            // committed-pendingId reconcile never fires. The FIX surfaces the echo via
            // echoedPendingIds (delegated to the underlying pre-strip timeline), so the
            // optimistic copy IS dropped even though the persisted row carries no pendingId.
            val under = FakeUnderlyingRepository()
            val repo = repoFor(under)

            intent.value = "conv-1" // client switch intent anchors paint + write-through
            // A committed USER entry carrying the optimistic pendingId on the SDK's own timeline.
            under.timelineState.value =
                listOf(ChatMessage(ts = 1, role = "user", content = "hello", pendingId = "p1", entryId = "e1"))
            runCurrent()

            // (1) The persisted DB row STRIPS pendingId — it is NOT in the durable store.
            val persisted = rows("conv-1")
            assertEquals(1, persisted.size)
            assertEquals("e1", persisted.single().entry_id)

            // (2) The DB-backed timeline the VM consumes also has pendingId=null (mirror strips it),
            //     and exactly ONE user bubble persists (the committed twin).
            val painted = repo.timeline.value
            assertEquals(1, painted.size)
            assertNull(painted.single().pendingId, "the mirror strips pendingId off the persisted timeline")

            // (3) The LIVE echo STILL surfaces the pendingId — the reconcile source the usecase
            //     filters against — so the optimistic outbox copy is dropped despite (2). scan over
            //     the StateFlow emits its seed (emptySet) first, then folds the held snapshot in;
            //     take the first non-empty emission (the folded value).
            assertTrue("p1" in repo.echoedPendingIds.first { it.isNotEmpty() }, "live echo surfaces the stripped pendingId")
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
