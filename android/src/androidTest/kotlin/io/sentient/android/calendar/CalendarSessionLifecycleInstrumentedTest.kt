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
import io.sentient.android.backend.BackendConfig
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ConnectionSecurity
import io.sentient.android.di.UserSessionManager
import io.sentient.android.settings.calendar.CalendarViewModel
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.cache.createCalendarCacheStore
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarView
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
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
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
    private val scenarioDatabases = CopyOnWriteArrayList<String>()

    @After
    fun cleanup() {
        context.deleteDatabase(databaseName)
        scenarioDatabases.forEach(context::deleteDatabase)
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
    fun realDatabase_closeReopen_andViewModelRecreation_activatePersistedMonthRow() {
        runBlocking(Dispatchers.IO) {
            val namespace = CalendarCacheNamespace("restore-account", "restore-backend")
            val preferences = CalendarCachePreferences(
                view = CalendarView.MONTH,
                anchorDate = "2026-08-24",
                scopes = listOf(CalendarScope.HOUSEHOLD),
                groups = listOf("family"),
                tags = listOf("school"),
                importance = Importance.PINNED,
                searchText = "sentinel",
                updatedAt = 99L,
            )
            val first = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
            val firstStore = createCalendarCacheStore(first, namespace, Dispatchers.IO)
            assertIs<CalendarCacheResult.Success<Unit>>(firstStore.writePreferences(preferences))
            val rowBeforeClose = CalendarDatabase(first.driver).calendarDatabaseQueries
                .preferencesForNamespace(namespace.accountId, namespace.backendId)
                .executeAsOne()
            assertEquals("month", rowBeforeClose.view_mode)
            assertEquals("2026-08-24", rowBeforeClose.anchor_date)
            firstStore.close()

            val reopened = openCalendarDatabase(AndroidCalendarDatabaseDriverFactory(context, databaseName))
            val reopenedStore = createCalendarCacheStore(reopened, namespace, Dispatchers.IO)
            val restoredRow = assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(reopenedStore.readPreferences()).value
            assertEquals(preferences, restoredRow)
            val experience = CalendarExperience(
                repository = NoopCalendarRepository(),
                cacheStore = reopenedStore,
                scope = CoroutineScope(Job() + Dispatchers.IO),
                initialAnchorDate = "1970-01-01",
            )
            val recreatedViewModel = CalendarViewModel(experience)
            try {
                withTimeout(2_000L) {
                    while (!recreatedViewModel.ui.value.restoredPresentationReady) yield()
                }
                val state = recreatedViewModel.ui.value
                assertEquals(CalendarView.MONTH, state.view)
                assertEquals("2026-08-24", state.anchorDate)
                assertEquals("2026-08-24", state.selectedDate)
                assertEquals(
                    CalendarFilters(
                        scope = CalendarScope.HOUSEHOLD,
                        groups = setOf("family"),
                        tags = setOf("school"),
                        importance = Importance.PINNED,
                        text = "sentinel",
                    ),
                    state.filters,
                )
            } finally {
                experience.close()
                reopenedStore.close()
            }
        }
    }

    @Test
    fun explicitLogout_at_publish_barrier_rejects_predecessor_and_exposes_successor() =
        exerciseManagerPublishRace("explicit-logout") { manager, successorUser ->
            manager.performLocalLogout()
            manager.beginAuthenticatedSession(successorUser)
            manager.component()
        }

    @Test
    fun authenticationExpiry_at_publish_barrier_rejects_predecessor_and_exposes_successor() =
        exerciseManagerPublishRace("auth-expiry") { manager, successorUser ->
            manager.onAuthenticationExpired()
            manager.beginAuthenticatedSession(successorUser)
            manager.component()
        }

    @Test
    fun accountReplacement_at_publish_barrier_rejects_predecessor_and_exposes_new_account() =
        exerciseManagerPublishRace("account-replacement") { manager, successorUser ->
            // component(explicitUserId) is the production account-replacement entry.
            manager.component(successorUser)
        }

    @Test
    fun backendReplacement_at_publish_barrier_rejects_predecessor_and_exposes_new_backend() =
        exerciseManagerPublishRace(
            scenario = "backend-replacement",
            successorBackend = BACKEND_B,
        ) { manager, successorUser ->
            BackendConfigHolder.store.save(BACKEND_B)
            manager.onBackendReplaced()
            manager.beginAuthenticatedSession(successorUser)
            manager.component()
        }

    @Test
    fun successorCreation_after_logout_cannot_inherit_paused_predecessor() =
        exerciseManagerPublishRace("successor-creation") { manager, successorUser ->
            manager.shutdown()
            manager.beginAuthenticatedSession(successorUser)
            manager.component()
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

    private fun exerciseManagerPublishRace(
        scenario: String,
        successorBackend: BackendConfig = BACKEND_A,
        replace: (UserSessionManager, String) -> Unit,
    ) = runBlocking {
        BackendConfigHolder.store.save(BACKEND_A)
        val database = "calendar-$scenario-${System.nanoTime()}.db"
        scenarioDatabases += database
        val driverFactory = AndroidCalendarDatabaseDriverFactory(context, database)
        val predecessorUser = "predecessor-$scenario"
        val successorUser = "successor-$scenario"
        val predecessorNamespace = calendarCacheNamespace(predecessorUser, BACKEND_A.toGatewayWsUrl())
        val successorNamespace = calendarCacheNamespace(successorUser, successorBackend.toGatewayWsUrl())
        val seed = createCalendarCacheStore(
            openCalendarDatabase(driverFactory),
            predecessorNamespace,
            Dispatchers.IO,
        )
        assertIs<CalendarCacheResult.Success<Unit>>(
            seed.writePreferences(CalendarCachePreferences(anchorDate = "2026-06-15")),
        )
        seed.close()

        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val initialized = AtomicInteger(0)
        val builtExperiences = CopyOnWriteArrayList<CalendarExperience>()
        val availableNamespaces = CopyOnWriteArrayList<CalendarCacheNamespace>()
        val manager = UserSessionManager(
            appContext = context,
            beforeCalendarPublish = { experience ->
                builtExperiences += experience
                if (initialized.incrementAndGet() == 1) {
                    entered.complete(Unit)
                    release.await()
                }
            },
            calendarDriverFactory = driverFactory,
        )
        val stateScope = CoroutineScope(Job() + Dispatchers.Default)
        val stateCollector = stateScope.launch {
            manager.calendarSessionState.collect { state ->
                if (state is CalendarSessionState.Available) availableNamespaces += state.namespace
            }
        }
        try {
            manager.component(predecessorUser)
            withTimeout(2_000L) { entered.await() }
            assertNull(manager.calendarExperience())

            replace(manager, successorUser)
            release.complete(Unit)
            withTimeout(4_000L) { manager.awaitCalendarLifecycle() }

            val predecessorExperience = builtExperiences.first()
            val successorExperience = manager.calendarExperience()
            val state = assertIs<CalendarSessionState.Available>(manager.calendarSessionState.value)
            assertTrue(predecessorExperience.isClosed)
            assertTrue(successorExperience != null && !successorExperience.isClosed)
            assertTrue(successorExperience !== predecessorExperience)
            assertSame(successorExperience, manager.settingsComponent().calendarExperience)
            assertEquals(successorNamespace, state.namespace)
            withTimeout(1_000L) {
                while (!availableNamespaces.contains(successorNamespace)) yield()
            }
            assertTrue(availableNamespaces.none { it == predecessorNamespace })
            assertTrue(availableNamespaces.all { it == successorNamespace })
        } finally {
            release.complete(Unit)
            manager.shutdown()
            withTimeout(4_000L) { manager.awaitCalendarLifecycle() }
            stateCollector.cancelAndJoin()
        }

        // The losing initializer owned a real AndroidSqliteDriver and purged its
        // seeded namespace before closing. Reopen independently to prove no row
        // or preference survived for a successor to inherit.
        val reopened = openCalendarDatabase(driverFactory)
        val queries = CalendarDatabase(reopened.driver).calendarDatabaseQueries
        assertTrue(
            queries.allSnapshotsForNamespace(
                predecessorNamespace.accountId,
                predecessorNamespace.backendId,
            ).executeAsList().isEmpty(),
        )
        assertTrue(
            queries.preferencesForNamespace(
                predecessorNamespace.accountId,
                predecessorNamespace.backendId,
            ).executeAsList().isEmpty(),
        )
        reopened.close()
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

    private companion object {
        val BACKEND_A = BackendConfig("calendar-a.invalid", 8443, ConnectionSecurity.TLS_VALID)
        val BACKEND_B = BackendConfig("calendar-b.invalid", 9443, ConnectionSecurity.TLS_VALID)
    }
}
