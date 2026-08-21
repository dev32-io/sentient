package io.sentient.mobiledata.cache.db

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class CalendarDatabaseFoundationTest {
    @Test
    fun `fresh schema exposes the expected version and complete snapshot primitives`() {
        val driver = newInMemoryDriver()
        try {
            val database = CalendarDatabase(driver)
            assertEquals(CALENDAR_DATABASE_SCHEMA_VERSION, CalendarDatabase.Schema.version)
            val queries = database.calendarDatabaseQueries
            queries.insertSnapshot(
                account_id = "account-a",
                backend_id = "backend-a",
                window_start = "2026-06-01",
                window_end = "2026-07-01",
                timezone_input = "America/Los_Angeles",
                is_complete = true,
                fetched_at = 1_700_000_000_000L,
                last_accessed_at = 1_700_000_000_100L,
                freshness = "fresh",
                occurrence_count = 0L,
            )

            val snapshot = queries.snapshotForWindow(
                "account-a",
                "backend-a",
                "2026-06-01",
                "2026-07-01",
                "America/Los_Angeles",
            ).executeAsList().single()
            assertTrue(snapshot.is_complete)
            assertEquals(1_700_000_000_000L, snapshot.fetched_at)
            assertEquals(1_700_000_000_100L, snapshot.last_accessed_at)
            assertEquals("fresh", snapshot.freshness)
        } finally {
            driver.close()
        }
    }

    @Test
    fun `version one fixture migrates data and backfills metadata without losing namespace`() {
        val driver = newLegacyDriver()
        try {
            CalendarDatabase.Schema.migrate(driver, oldVersion = 1L, newVersion = 2L)
            val database = CalendarDatabase(driver)
            val row = database.calendarDatabaseQueries.snapshotForWindow(
                "account-a",
                "backend-a",
                "2026-06-01",
                "2026-07-01",
                "wire",
            ).executeAsList().single()

            assertEquals("account-a", row.account_id)
            assertEquals("backend-a", row.backend_id)
            assertTrue(row.is_complete)
            assertEquals(0L, row.last_accessed_at)
            assertEquals("stale", row.freshness)
        } finally {
            driver.close()
        }
    }

    @Test
    fun `namespace and complete window keys reject collisions but permit isolated rows`() {
        val driver = newInMemoryDriver()
        try {
            val queries = CalendarDatabase(driver).calendarDatabaseQueries
            insertSnapshot(queries, account = "account-a", backend = "backend-a")

            assertFailsWith<Throwable> {
                insertSnapshot(queries, account = "account-a", backend = "backend-a")
            }

            insertSnapshot(queries, account = "account-b", backend = "backend-a")
            insertSnapshot(queries, account = "account-a", backend = "backend-b")
            insertSnapshot(queries, account = "account-a", backend = "backend-a", month = "2026-07-01")

            assertEquals(2, queries.allSnapshotsForNamespace("account-a", "backend-a").executeAsList().size)
            assertEquals(1, queries.allSnapshotsForNamespace("account-b", "backend-a").executeAsList().size)
            assertEquals(1, queries.allSnapshotsForNamespace("account-a", "backend-b").executeAsList().size)
        } finally {
            driver.close()
        }
    }

    @Test
    fun `failed transaction leaves no partial snapshot or occurrence`() {
        val driver = newInMemoryDriver()
        try {
            val database = CalendarDatabase(driver)
            val queries = database.calendarDatabaseQueries
            val failure = assertFailsWith<IllegalStateException> {
                database.transaction {
                    insertSnapshot(queries, account = "account-a", backend = "backend-a")
                    insertOccurrence(queries)
                    error("synthetic transaction failure")
                }
            }
            assertEquals("synthetic transaction failure", failure.message)
            assertTrue(
                queries.snapshotForWindow(
                    "account-a",
                    "backend-a",
                    "2026-06-01",
                    "2026-07-01",
                    "wire",
                ).executeAsList().isEmpty(),
            )
            assertTrue(
                queries.occurrencesForWindow(
                    "account-a",
                    "backend-a",
                    "2026-06-01",
                    "2026-07-01",
                    "wire",
                ).executeAsList().isEmpty(),
            )

            // A committed but incomplete staging snapshot is never observable as
            // authoritative occurrences until its marker is flipped atomically.
            insertSnapshot(queries, account = "account-a", backend = "backend-a", complete = false)
            insertOccurrence(queries)
            assertTrue(
                queries.occurrencesForWindow(
                    "account-a",
                    "backend-a",
                    "2026-06-01",
                    "2026-07-01",
                    "wire",
                ).executeAsList().isEmpty(),
            )
            queries.updateSnapshotMetadata(
                is_complete = true,
                fetched_at = 3L,
                last_accessed_at = 4L,
                freshness = "fresh",
                occurrence_count = 1L,
                account_id = "account-a",
                backend_id = "backend-a",
                window_start = "2026-06-01",
                window_end = "2026-07-01",
                timezone_input = "wire",
            )
            assertEquals(
                1,
                queries.occurrencesForWindow(
                    "account-a",
                    "backend-a",
                    "2026-06-01",
                    "2026-07-01",
                    "wire",
                ).executeAsList().size,
            )
        } finally {
            driver.close()
        }
    }

    @Test
    fun `occurrence preserves identity raw temporal values and payload fields`() {
        val driver = newInMemoryDriver()
        try {
            val queries = CalendarDatabase(driver).calendarDatabaseQueries
            insertSnapshot(queries, account = "account-a", backend = "backend-a")
            queries.insertOccurrence(
                account_id = "account-a",
                backend_id = "backend-a",
                window_start = "2026-06-01",
                window_end = "2026-07-01",
                timezone_input = "wire",
                occurrence_id = "occurrence-1",
                event_id = "event-1",
                original_start = "2026-06-14T09:30:00-07:00",
                original_start_is_all_day = false,
                start_value = "2026-06-14T10:30:00-06:00",
                start_is_all_day = false,
                end_value = "2026-06-14T11:30:00-06:00",
                end_is_all_day = false,
                recurring = true,
                revision = 7L,
                scope = "household",
                visibility = "everyone",
                title = "Breakfast",
                description = "A description",
                importance = "important",
                group_name = "Family",
                tags_json = "[\"meal\"]",
                recurrence_json = "{\"frequency\":\"weekly\"}",
                payload_json = "{\"eventId\":\"event-1\",\"occurrenceId\":\"occurrence-1\"}",
            )

            val row = queries.occurrencesForWindow(
                "account-a",
                "backend-a",
                "2026-06-01",
                "2026-07-01",
                "wire",
            ).executeAsList().single()
            assertEquals("event-1", row.event_id)
            assertEquals("occurrence-1", row.occurrence_id)
            assertEquals("2026-06-14T09:30:00-07:00", row.original_start)
            assertFalse(row.original_start_is_all_day)
            assertEquals("2026-06-14T10:30:00-06:00", row.start_value)
            assertEquals("2026-06-14T11:30:00-06:00", row.end_value)
            assertTrue(row.recurring)
            assertEquals(7L, row.revision)
            assertEquals("household", row.scope)
            assertEquals("everyone", row.visibility)
            assertEquals("{\"frequency\":\"weekly\"}", row.recurrence_json)
            assertEquals("{\"eventId\":\"event-1\",\"occurrenceId\":\"occurrence-1\"}", row.payload_json)
        } finally {
            driver.close()
        }
    }

    @Test
    fun `preferences are one record per account backend namespace`() {
        val driver = newInMemoryDriver()
        try {
            val queries = CalendarDatabase(driver).calendarDatabaseQueries
            queries.upsertPreferences(
                account_id = "account-a",
                backend_id = "backend-a",
                view_mode = "month",
                anchor_date = "2026-06-14",
                scopes_json = "[\"private\",\"household\"]",
                groups_json = "[\"Family\"]",
                tags_json = "[\"meal\"]",
                importance_json = "[\"important\"]",
                search_text = "breakfast",
                updated_at = 3L,
            )
            queries.upsertPreferences(
                account_id = "account-a",
                backend_id = "backend-b",
                view_mode = "week",
                anchor_date = "2026-06-15",
                scopes_json = "[\"household\"]",
                groups_json = "[]",
                tags_json = "[]",
                importance_json = "[]",
                search_text = "",
                updated_at = 4L,
            )

            val first = queries.preferencesForNamespace("account-a", "backend-a").executeAsList().single()
            val second = queries.preferencesForNamespace("account-a", "backend-b").executeAsList().single()
            assertEquals("month", first.view_mode)
            assertEquals("breakfast", first.search_text)
            assertEquals("week", second.view_mode)
            assertEquals("[\"household\"]", second.scopes_json)
        } finally {
            driver.close()
        }
    }

    @Test
    fun `database data survives close and reopen on a file driver`() {
        val path = Files.createTempFile("sentient-calendar-", ".sqlite")
        Files.deleteIfExists(path)
        try {
            val firstDriver = JdbcSqliteDriver("jdbc:sqlite:${path.toAbsolutePath()}")
            CalendarDatabase.Schema.create(firstDriver)
            insertSnapshot(CalendarDatabase(firstDriver).calendarDatabaseQueries, "account-a", "backend-a")
            firstDriver.close()

            val secondDriver = JdbcSqliteDriver("jdbc:sqlite:${path.toAbsolutePath()}")
            try {
                val rows = CalendarDatabase(secondDriver).calendarDatabaseQueries
                    .allSnapshotsForNamespace("account-a", "backend-a")
                    .executeAsList()
                assertEquals(1, rows.size)
            } finally {
                secondDriver.close()
            }
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun `driver open failure is typed and content free`() {
        val failure = assertFailsWith<CalendarDatabaseOpenException> {
            openCalendarDatabase { error("private database path and payload") }
        }
        assertEquals(null, failure.message)
        assertTrue("private database" !in failure.toString())
    }

    @Test
    fun `common handle closes the injected driver`() {
        val driver = newInMemoryDriver()
        val handle = openCalendarDatabase { driver }
        assertNotNull(handle.database)
        assertEquals(CALENDAR_DATABASE_SCHEMA_VERSION, handle.schemaVersion)
        handle.close()
        handle.close()
        assertFailsWith<Throwable> {
            driver.execute(null, "SELECT 1", 0)
        }
    }

    private fun newInMemoryDriver(): JdbcSqliteDriver {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        CalendarDatabase.Schema.create(driver)
        return driver
    }

    private fun newLegacyDriver(): JdbcSqliteDriver {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
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
        driver.execute(
            null,
            """
            INSERT INTO calendar_month_snapshot(
              account_id, backend_id, window_start, window_end, timezone_input,
              is_complete, fetched_at, occurrence_count
            ) VALUES ('account-a', 'backend-a', '2026-06-01', '2026-07-01', 'wire', 1, 42, 0)
            """.trimIndent(),
            0,
        )
        return driver
    }

    private fun insertSnapshot(
        queries: CalendarDatabaseQueries,
        account: String,
        backend: String,
        month: String = "2026-06-01",
        complete: Boolean = true,
    ) {
        queries.insertSnapshot(
            account_id = account,
            backend_id = backend,
            window_start = month,
            window_end = if (month == "2026-06-01") "2026-07-01" else "2026-08-01",
            timezone_input = "wire",
            is_complete = complete,
            fetched_at = 1L,
            last_accessed_at = 2L,
            freshness = "fresh",
            occurrence_count = 0L,
        )
    }

    private fun insertOccurrence(queries: CalendarDatabaseQueries) {
        queries.insertOccurrence(
            account_id = "account-a",
            backend_id = "backend-a",
            window_start = "2026-06-01",
            window_end = "2026-07-01",
            timezone_input = "wire",
            occurrence_id = "occurrence-1",
            event_id = "event-1",
            original_start = "2026-06-14",
            original_start_is_all_day = true,
            start_value = "2026-06-14",
            start_is_all_day = true,
            end_value = "2026-06-15",
            end_is_all_day = true,
            recurring = false,
            revision = 1L,
            scope = "private",
            visibility = "everyone",
            title = "Test",
            description = null,
            importance = "normal",
            group_name = null,
            tags_json = "[]",
            recurrence_json = null,
            payload_json = "{}",
        )
    }
}
