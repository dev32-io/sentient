package io.sentient.mobiledata.di

import app.cash.sqldelight.db.AfterVersion
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.db.SqlSchema
import app.cash.sqldelight.driver.native.NativeSqliteDriver
import io.sentient.mobiledata.cache.db.CalendarDatabase
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSFileManager
import kotlin.test.Test
import kotlin.test.assertEquals
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
}
