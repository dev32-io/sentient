// ---------------------------------------------------------------------------
// CachingSessionsRepositoryTest — pins the cache-then-refresh + smart-async
// deletion decorator against a REAL in-memory SQLite DB on the JVM host.
//
// The decorator wraps a SessionsRepository (here a fake REST repo returning a
// configurable session list + recording delete/rename) and:
//   • serves list() from the DB cache (instant paint) + refreshes in background,
//   • write-throughs every REST session into the `session` table (DESC updated_at),
//   • on refresh diffs the local id set against the server set and smart-async-
//     deletes locally-stale sessions + cascades their messages,
//   • mirrors delete/rename optimistically into the cache before delegating.
//
// The background refresh launches on backgroundScope (auto-cancelled at test end)
// and the SAME UnconfinedTestDispatcher backs both the cache reads and the writes,
// so runCurrent() deterministically flushes write-through + smart-async deletion.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.data

import io.sentient.mobiledata.cache.db.ChatDatabase
import io.sentient.mobiledata.cache.db.InMemoryDatabaseDriverFactory
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeSessionsRepository(var serverList: List<SessionSummary>) : SessionsRepository {
    val deleted = mutableListOf<String>()
    val renamed = mutableListOf<Pair<String, String>>()
    val switched = mutableListOf<String>()
    var newChats = 0

    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> =
        serverList.drop(offset).take(limit)

    override fun newChatFireAndForget() { newChats++ }
    override fun switchToFireAndForget(sessionId: String) { switched.add(sessionId) }
    override suspend fun switchTo(sessionId: String) { switched.add(sessionId) }
    override suspend fun newChat(): String { newChats++; return "new" }
    override suspend fun rename(sessionId: String, title: String) { renamed.add(sessionId to title) }
    override suspend fun delete(sessionId: String) { deleted.add(sessionId) }
}

class CachingSessionsRepositoryTest {

    private val driver = InMemoryDatabaseDriverFactory().create()
    private val db = ChatDatabase(driver)
    private val q = db.chatDatabaseQueries

    @AfterTest
    fun tearDown() = driver.close()

    private fun TestScope.repoFor(under: SessionsRepository): CachingSessionsRepository {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        return CachingSessionsRepository(under, db, scope = backgroundScope, ioDispatcher = dispatcher)
    }

    private fun summary(id: String, title: String, ts: Long) = SessionSummary(id, title, ts)

    private fun seedSession(id: String, title: String, ts: Long) =
        q.upsertSession(id = id, title = title, updated_at = ts)

    private fun seedMessage(conv: String, entry: String) = q.upsertMessage(
        entry_id = entry, conversation_id = conv, seq = 0,
        role = "user", content = "x", ts = 0, cutoff_kind = null,
    )

    private fun cachedIds() = q.allSessionIds().executeAsList()

    @Test
    fun `write-through — a REST list of 3 sessions lands in the DB ordered by updated_at DESC`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeSessionsRepository(
                listOf(summary("a", "A", 30), summary("b", "B", 10), summary("c", "C", 20)),
            )
            val repo = repoFor(under)

            // Cold cache → list() awaits the REST refresh then returns the cached page.
            val result = repo.list(limit = 100, offset = 0)
            runCurrent()

            val cached = q.allSessions().executeAsList()
            assertEquals(3, cached.size)
            // DESC updated_at: a(30), c(20), b(10).
            assertEquals(listOf("a", "c", "b"), cached.map { it.id })
            assertEquals(listOf("a", "c", "b"), result.map { it.id })
        }

    @Test
    fun `cache-then-refresh — stale cache paints first, then the REST set replaces it`() =
        runTest(UnconfinedTestDispatcher()) {
            // Seed a STALE cache (as if from a prior launch).
            seedSession("a", "OLD-A", 5)
            seedSession("old", "GONE", 1)
            val under = FakeSessionsRepository(
                listOf(summary("a", "NEW-A", 50), summary("z", "Z", 40)),
            )
            val repo = repoFor(under)

            // Warm cache → instant paint of the STALE rows; refresh runs in background.
            val instant = repo.list(limit = 100, offset = 0)
            assertEquals(listOf("a", "old"), instant.map { it.id }) // stale, a(5)>old(1) DESC
            assertEquals("OLD-A", instant.first().title)

            runCurrent() // flush the background refresh

            // After refresh the DB reflects the REST set: a re-titled, z added, old dropped.
            val refreshed = q.allSessions().executeAsList()
            assertEquals(listOf("a", "z"), refreshed.map { it.id }) // a(50)>z(40)
            assertEquals("NEW-A", refreshed.first { it.id == "a" }.title)
            assertNull(refreshed.firstOrNull { it.id == "old" })
        }

    @Test
    fun `smart-async deletion — a session absent from the REST set is dropped with its messages`() =
        runTest(UnconfinedTestDispatcher()) {
            // DB has [A,B,C]; B carries messages that must cascade-delete.
            seedSession("A", "A", 30); seedSession("B", "B", 20); seedSession("C", "C", 10)
            seedMessage("B", "B:0"); seedMessage("B", "B:1")
            seedMessage("A", "A:0") // A's messages must survive.

            // REST returns [A,C] — B deleted server-side.
            val under = FakeSessionsRepository(listOf(summary("A", "A", 30), summary("C", "C", 10)))
            val repo = repoFor(under)

            repo.list(limit = 100, offset = 0) // warm cache → background refresh
            runCurrent()

            assertEquals(listOf("A", "C"), q.allSessions().executeAsList().map { it.id })
            assertTrue(cachedIds().none { it == "B" })
            // Cascade: B's messages gone, A's remain.
            assertTrue(q.messagesFor("B").executeAsList().isEmpty())
            assertEquals(1, q.messagesFor("A").executeAsList().size)
        }

    @Test
    fun `local delete optimism — delete removes the session + its messages locally AND delegates`() =
        runTest(UnconfinedTestDispatcher()) {
            seedSession("A", "A", 30); seedSession("B", "B", 20)
            seedMessage("A", "A:0"); seedMessage("B", "B:0")
            val under = FakeSessionsRepository(listOf(summary("A", "A", 30), summary("B", "B", 20)))
            val repo = repoFor(under)

            repo.delete("A")
            runCurrent()

            // Local optimism: A + A's messages gone immediately.
            assertTrue(cachedIds().none { it == "A" })
            assertTrue(q.messagesFor("A").executeAsList().isEmpty())
            assertTrue(cachedIds().contains("B"))
            // Delegated to the REST repo.
            assertEquals(listOf("A"), under.deleted)
        }

    @Test
    fun `local rename optimism — rename updates the cached title AND delegates`() =
        runTest(UnconfinedTestDispatcher()) {
            seedSession("A", "OLD", 30)
            val under = FakeSessionsRepository(listOf(summary("A", "OLD", 30)))
            val repo = repoFor(under)

            repo.rename("A", "NEW")
            runCurrent()

            val row = q.allSessions().executeAsList().single { it.id == "A" }
            assertEquals("NEW", row.title)
            assertEquals(30, row.updated_at) // ts preserved
            assertEquals(listOf("A" to "NEW"), under.renamed)
        }

    @Test
    fun `switch and new-chat delegate straight through`() =
        runTest(UnconfinedTestDispatcher()) {
            val under = FakeSessionsRepository(emptyList())
            val repo = repoFor(under)

            repo.switchTo("s1")
            repo.switchToFireAndForget("s2")
            repo.newChatFireAndForget()
            repo.newChat()

            assertEquals(listOf("s1", "s2"), under.switched)
            assertEquals(2, under.newChats)
        }

    @Test
    fun `rename cached — preserves updated_at, no bottom-float`() =
        runTest(UnconfinedTestDispatcher()) {
            seedSession("A", "OLD", 100)
            seedSession("B", "B", 50)
            val under = FakeSessionsRepository(listOf(summary("A", "OLD", 100), summary("B", "B", 50)))
            val repo = repoFor(under)

            repo.rename("A", "NEW")
            runCurrent()

            val row = q.allSessions().executeAsList().single { it.id == "A" }
            assertEquals("NEW", row.title)
            // updated_at must be preserved so A stays atop B in DESC order.
            assertEquals(100, row.updated_at)
            assertEquals(listOf("A" to "NEW"), under.renamed)
        }

    @Test
    fun `rename uncached — delegates without inserting a 0L row`() =
        runTest(UnconfinedTestDispatcher()) {
            // DB is empty — session not in cache (defensive path).
            val under = FakeSessionsRepository(emptyList())
            val repo = repoFor(under)

            repo.rename("X", "TITLE")
            runCurrent()

            // No row must have been inserted with a 0L timestamp.
            assertTrue(q.allSessions().executeAsList().none { it.id == "X" })
            // REST rename was still delegated.
            assertEquals(listOf("X" to "TITLE"), under.renamed)
        }
}
