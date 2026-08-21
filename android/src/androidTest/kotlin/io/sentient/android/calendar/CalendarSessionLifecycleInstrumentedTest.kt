package io.sentient.android.calendar

import android.content.Context
import android.os.Looper
import app.cash.sqldelight.db.AfterVersion
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.sentient.android.di.UserSessionManager
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.cache.createCalendarCacheStore
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Real-driver proof for the authenticated calendar storage boundary. */
@RunWith(AndroidJUnit4::class)
class CalendarSessionLifecycleInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val databaseName = "calendar-test-${System.nanoTime()}.db"

    @After
    fun cleanup() {
        context.deleteDatabase(databaseName)
    }

    @Test
    fun realAndroidDriver_opens_migrates_reopens_and_closes() {
        runBlocking(Dispatchers.IO) {
        assertFalse(Looper.myLooper() == Looper.getMainLooper())
        val legacy = AndroidSqliteDriver(
            schema = legacySchema(),
            context = context,
            name = databaseName,
        )
        legacy.execute(
            null,
            """
            INSERT INTO calendar_month_snapshot(
              account_id, backend_id, window_start, window_end, timezone_input,
              is_complete, fetched_at, occurrence_count
            ) VALUES ('account-a', 'wss|backend-a|443|api/v1', '2026-06-01', '2026-07-01', 'UTC', 1, 42, 0)
            """.trimIndent(),
            0,
        )
        legacy.close()

        val first = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
        val migratedRows = CalendarDatabase(first.driver).calendarDatabaseQueries
            .snapshotForWindow("account-a", "wss|backend-a|443|api/v1", "2026-06-01", "2026-07-01", "UTC")
            .executeAsList()
        assertEquals(1, migratedRows.size)
        assertEquals(42L, migratedRows.single().fetched_at)
        assertEquals(0L, migratedRows.single().last_accessed_at)
        assertEquals("stale", migratedRows.single().freshness)
        assertEquals(2L, first.schemaVersion)
        first.close()

        val reopened = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
        val reopenedRows = CalendarDatabase(reopened.driver).calendarDatabaseQueries
            .snapshotForWindow("account-a", "wss|backend-a|443|api/v1", "2026-06-01", "2026-07-01", "UTC")
            .executeAsList()
        assertEquals(1, reopenedRows.size)
        assertEquals(42L, reopenedRows.single().fetched_at)
        reopened.close()
        }
    }

    @Test
    fun sessionClose_at_publish_barrier_closes_late_unpublished_experience() {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var lateExperience: CalendarExperience? = null
        val manager = UserSessionManager(
            appContext = context,
            beforeCalendarPublish = { experience ->
                lateExperience = experience
                entered.complete(Unit)
                release.await()
            },
        )
        try {
            manager.component("barrier-user")
            runBlocking {
                withTimeout(2_000L) { entered.await() }
                manager.shutdown()
                release.complete(Unit)
                withTimeout(2_000L) { manager.awaitCalendarLifecycle() }
            }
            assertNull(manager.calendarExperience())
            assertTrue(lateExperience?.isClosed == true)
            assertIs<CalendarSessionState.Unauthenticated>(manager.calendarSessionState.value)
        } finally {
            release.complete(Unit)
            manager.shutdown()
        }
    }

    @Test
    fun sessionScopedExperience_survives_route_reads_and_closes_before_successor() {
        runBlocking(Dispatchers.IO) {
        assertFalse(Looper.myLooper() == Looper.getMainLooper())
        val handle = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
        val store = createCalendarCacheStore(
            handle,
            CalendarCacheNamespace("route-account", "backend"),
            Dispatchers.IO,
        )
        val experience = CalendarExperience(
            repository = NoopCalendarRepository(),
            cacheStore = store,
            scope = CoroutineScope(Job() + Dispatchers.IO),
        )
        try {
            val routeOne = experience
            val routeTwo = experience
            assertSame(routeOne, routeTwo)
            experience.observe(CalendarCacheWindow("2026-06-01", "2026-07-01", "UTC"))
            experience.disposeAndPurge()
            assertTrue(experience.isClosed)
            assertTrue(store.isClosed)
        } finally {
            experience.close()
            store.close()
        }
        }
    }

    @Test
    fun sessionBoundary_purgesOutside_cancelledScope_and_isolates_account_backend() {
        runBlocking(Dispatchers.IO) {
        assertFalse(Looper.myLooper() == Looper.getMainLooper())
        val handle = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
        val accountA = CalendarCacheNamespace("account-a", "backend-a")
        val accountB = CalendarCacheNamespace("account-b", "backend-b")
        val window = CalendarCacheWindow("2026-06-01", "2026-07-01", "UTC")
        val store = createCalendarCacheStore(handle, accountA, Dispatchers.IO)
        try {
            store.writePreferences(
                io.sentient.mobiledata.cache.CalendarCachePreferences(anchorDate = "2026-06-15"),
            )
            assertIs<CalendarCacheResult.Success<Unit>>(
                store.replaceSnapshot(window, emptyList(), fetchedAt = 2L),
            )

            val cancelledScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Job() + Dispatchers.IO)
            val cancelledJob = cancelledScope.launch { kotlinx.coroutines.awaitCancellation() }
            cancelledJob.cancelAndJoin()
            withContext(NonCancellable + Dispatchers.IO) {
                assertIs<CalendarCacheResult.Success<Unit>>(store.purgeNamespace(accountA))
            }

            assertIs<CalendarCacheResult.Success<Unit>>(store.switchNamespace(accountB, purgePrevious = true))
            assertNull(
                assertIs<CalendarCacheResult.Success<io.sentient.mobiledata.cache.CalendarCacheSnapshot?>>(
                    store.readSnapshot(window),
                ).value,
            )
            assertNull(
                assertIs<CalendarCacheResult.Success<io.sentient.mobiledata.cache.CalendarCachePreferences?>>(
                    store.readPreferences(),
                ).value,
            )

            // The non-cancelled successor operation is bounded and remains on
            // the same background executor used by the real driver.
            withTimeout(1_000L) {
                assertIs<CalendarCacheResult.Success<Unit>>(store.purgeNamespace(accountB))
            }
        } finally {
            store.close()
        }
        }
    }

    private fun legacySchema(): SqlSchema<QueryResult.Value<Unit>> = object : SqlSchema<QueryResult.Value<Unit>> {
        override val version: Long = 1L

        override fun create(driver: SqlDriver): QueryResult.Value<Unit> {
            driver.execute(
                null,
                """
                CREATE TABLE calendar_month_snapshot (
                  account_id TEXT NOT NULL,
                  backend_id TEXT NOT NULL,
                  window_start TEXT NOT NULL,
                  window_end TEXT NOT NULL,
                  timezone_input TEXT NOT NULL,
                  is_complete INTEGER NOT NULL,
                  fetched_at INTEGER NOT NULL,
                  occurrence_count INTEGER NOT NULL,
                  PRIMARY KEY (account_id, backend_id, window_start, window_end, timezone_input)
                )
                """.trimIndent(),
                0,
            )
            return QueryResult.Unit
        }

        override fun migrate(
            driver: SqlDriver,
            oldVersion: Long,
            newVersion: Long,
            vararg callbacks: AfterVersion,
        ): QueryResult.Value<Unit> = QueryResult.Unit
    }

    private class NoopCalendarRepository : CalendarRepository {
        private fun <T : Any> failure(): SentientResult<T> = SentientResult.Failure(
            SentientError.Connection("network unavailable"),
        )

        override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?): SentientResult<CalendarEvent> = failure()

        override suspend fun list(
            from: String,
            to: String,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
            cursor: String?,
            query: String?,
            limit: Int?,
        ): SentientResult<CalendarEventPage> = SentientResult.Success(CalendarEventPage(emptyList()))

        override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = failure()

        override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> = failure()

        override suspend fun mutate(
            eventId: String,
            command: CalendarMutationCommand,
        ): SentientResult<CalendarMutationResult> = failure()
    }
}
