package io.sentient.mobiledata.di

import app.cash.sqldelight.db.AfterVersion
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import app.cash.sqldelight.driver.native.NativeSqliteDriver
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.CalendarDatabaseDriverFactory
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSFileManager
import platform.Foundation.NSThread
import platform.Foundation.NSTemporaryDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import io.sentient.mobiledata.calendar.CalendarExperience
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.cache.createCalendarCacheStore
import kotlin.test.assertNull
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue

@OptIn(ExperimentalForeignApi::class)
class IosCalendarDatabaseFactoryTest {
    @Test
    fun `protected factory opens migrates reopens and closes`() {
        val factory = IosCalendarDatabaseDriverFactory()
        val path = factory.databasePath()
        val manager = NSFileManager.defaultManager
        listOf(path, "$path-wal", "$path-shm", "$path-journal").forEach {
            manager.removeItemAtPath(it, error = null)
        }
        val basePath = path.substringBeforeLast('/')
        check(manager.createDirectoryAtPath(basePath, true, null, null))
        val legacy = NativeSqliteDriver(
            schema = legacySchema(),
            name = "calendar.sqlite",
            onConfiguration = { configuration ->
                configuration.copy(
                    extendedConfig = configuration.extendedConfig.copy(basePath = basePath),
                )
            },
        )
        legacy.execute(
            null,
            """
            INSERT INTO calendar_month_snapshot(
              account_id, backend_id, window_start, window_end, timezone_input,
              is_complete, fetched_at, occurrence_count
            ) VALUES ('account-a', 'backend-a', '2026-06-01', '2026-07-01', 'wire', 1, 42, 0)
            """.trimIndent(),
            0,
        )
        legacy.close()

        val driver = factory.create()
        val migrated = CalendarDatabase(driver).calendarDatabaseQueries
            .snapshotForWindow("account-a", "backend-a", "2026-06-01", "2026-07-01", "wire")
            .executeAsList()
            .single()
        assertTrue(migrated.is_complete)
        assertEquals(0L, migrated.last_accessed_at)
        assertEquals("stale", migrated.freshness)
        driver.close()

        val reopened = factory.create()
        assertTrue(
            CalendarDatabase(reopened).calendarDatabaseQueries
                .snapshotForWindow("account-a", "backend-a", "2026-06-01", "2026-07-01", "wire")
                .executeAsList()
                .isNotEmpty(),
        )
        reopened.close()
    }

    @Test
    fun `explicit logout at publish barrier rejects predecessor and exposes successor`() =
        exerciseSessionPublishRace("explicit-logout") { it.explicitLogout() }

    @Test
    fun `authentication expiry at publish barrier rejects predecessor and exposes successor`() =
        exerciseSessionPublishRace("auth-expiry") { it.authenticationExpired() }

    @Test
    fun `account replacement at publish barrier rejects predecessor and exposes new account`() =
        exerciseSessionPublishRace("account-replacement") { it.accountReplaced() }

    @Test
    fun `backend replacement at publish barrier rejects predecessor and exposes new backend`() =
        exerciseSessionPublishRace(
            scenario = "backend-replacement",
            successorGateway = IOS_GATEWAY_B,
        ) { it.backendReplaced() }

    @Test
    fun `successor creation after owner release cannot inherit paused predecessor`() =
        exerciseSessionPublishRace("successor-creation") { it.close() }

    @Test
    fun `session purge switch isolation and stale emission stay bounded off main`() = runBlocking(Dispatchers.Default) {
        assertTrue(!NSThread.isMainThread)
        val factory = IosCalendarDatabaseDriverFactory()
        val path = factory.databasePath()
        val manager = NSFileManager.defaultManager
        listOf(path, "$path-wal", "$path-shm", "$path-journal").forEach {
            manager.removeItemAtPath(it, error = null)
        }
        val handle = io.sentient.mobiledata.cache.db.openCalendarDatabase(factory)
        val accountA = CalendarCacheNamespace("account-a", "backend-a")
        val accountB = CalendarCacheNamespace("account-b", "backend-b")
        val window = CalendarCacheWindow("2026-06-01", "2026-07-01", "UTC")
        val store = createCalendarCacheStore(handle, accountA, Dispatchers.Default)
        try {
            assertIs<CalendarCacheResult.Success<Unit>>(
                store.replaceSnapshot(window, emptyList(), fetchedAt = 10L),
            )
            assertIs<CalendarCacheResult.Success<Unit>>(
                store.writePreferences(CalendarCachePreferences(anchorDate = "2026-06-15")),
            )

            val cancelledScope = CoroutineScope(Job() + Dispatchers.Default)
            val cancelled = cancelledScope.launch { awaitCancellation() }
            cancelled.cancelAndJoin()
            withContext(NonCancellable + Dispatchers.Default) {
                withTimeout(1_000L) {
                    assertIs<CalendarCacheResult.Success<Unit>>(store.purgeNamespace(accountA))
                }
            }

            assertIs<CalendarCacheResult.Success<Unit>>(store.switchNamespace(accountB, purgePrevious = true))
            val successorEmission = store.observeSnapshot(window).first()
            assertNull(assertIs<CalendarCacheResult.Success<io.sentient.mobiledata.cache.CalendarCacheSnapshot?>>(successorEmission).value)
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(store.readPreferences()).value)

            // A user/backend successor cannot resurrect the predecessor rows.
            assertIs<CalendarCacheResult.Success<Unit>>(store.switchNamespace(accountA, purgePrevious = false))
            assertNull(assertIs<CalendarCacheResult.Success<io.sentient.mobiledata.cache.CalendarCacheSnapshot?>>(store.readSnapshot(window)).value)
        } finally {
            store.close()
        }
    }

    private fun exerciseSessionPublishRace(
        scenario: String,
        successorGateway: String = IOS_GATEWAY_A,
        replace: (IosUserSession) -> Unit,
    ): Unit = runBlocking(Dispatchers.Default) {
        val fileManager = NSFileManager.defaultManager
        val basePath = "${NSTemporaryDirectory()}sentient-calendar-$scenario-${kotlin.random.Random.nextLong()}"
        check(fileManager.createDirectoryAtPath(basePath, true, null, null))
        val driverFactory = TemporaryNativeCalendarDriverFactory(basePath)
        val predecessorUser = "predecessor-$scenario"
        val successorUser = "successor-$scenario"
        val predecessorNamespace = iosCalendarNamespace(predecessorUser, IOS_GATEWAY_A)
        val successorNamespace = iosCalendarNamespace(successorUser, successorGateway)
        val seed = createCalendarCacheStore(
            io.sentient.mobiledata.cache.db.openCalendarDatabase(driverFactory),
            predecessorNamespace,
            Dispatchers.Default,
        )
        assertIs<CalendarCacheResult.Success<Unit>>(
            seed.writePreferences(CalendarCachePreferences(anchorDate = "2026-06-15")),
        )
        seed.close()

        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val predecessorExperience = CompletableDeferred<CalendarExperience>()
        val predecessor = IosUserSession(
            gatewayWsUrl = IOS_GATEWAY_A,
            allowSelfSignedDevHost = false,
            authenticatedUserId = predecessorUser,
            beforeCalendarPublish = { experience ->
                predecessorExperience.complete(experience)
                entered.complete(Unit)
                release.await()
            },
            calendarDriverFactory = driverFactory,
        )
        var successor: IosUserSession? = null
        try {
            withTimeout(2_000L) { entered.await() }
            assertNull(predecessor.calendarExperience)

            replace(predecessor)
            assertNull(predecessor.calendarExperience)
            successor = IosUserSession(
                gatewayWsUrl = successorGateway,
                allowSelfSignedDevHost = false,
                authenticatedUserId = successorUser,
                calendarDriverFactory = driverFactory,
            )
            release.complete(Unit)
            withTimeout(4_000L) { predecessor.awaitCalendarLifecycle() }
            withTimeout(4_000L) { successor.awaitCalendarLifecycle() }

            val losingExperience = predecessorExperience.await()
            val successorExperience = successor.calendarExperience
            assertTrue(losingExperience.isClosed)
            assertNull(predecessor.calendarExperience)
            assertNull(predecessor.settings.calendarExperience)
            assertNull(predecessor.calendarNamespace)
            assertEquals(IosCalendarUnavailableReason.CLOSED, predecessor.calendarAvailability.unavailableReason)
            assertTrue(successorExperience != null && !successorExperience.isClosed)
            assertNotSame(losingExperience, successorExperience)
            assertSame(successorExperience, successor.settings.calendarExperience)
            assertEquals(successorNamespace, successor.calendarNamespace)
        } finally {
            release.complete(Unit)
            predecessor.close()
            successor?.close()
            withTimeout(4_000L) { predecessor.awaitCalendarLifecycle() }
            successor?.let { withTimeout(4_000L) { it.awaitCalendarLifecycle() } }
        }

        val reopened = io.sentient.mobiledata.cache.db.openCalendarDatabase(driverFactory)
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
        fileManager.removeItemAtPath(basePath, error = null)
        Unit
    }

    private class TemporaryNativeCalendarDriverFactory(
        private val basePath: String,
    ) : CalendarDatabaseDriverFactory {
        override fun create(): SqlDriver = NativeSqliteDriver(
            schema = CalendarDatabase.Schema,
            name = "calendar.sqlite",
            onConfiguration = { configuration ->
                configuration.copy(
                    extendedConfig = configuration.extendedConfig.copy(
                        basePath = basePath,
                        foreignKeyConstraints = true,
                    ),
                )
            },
        )
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

    private companion object {
        const val IOS_GATEWAY_A = "wss://calendar-a.invalid:8443/api/v1/ws"
        const val IOS_GATEWAY_B = "wss://calendar-b.invalid:9443/api/v1/ws"
    }
}
