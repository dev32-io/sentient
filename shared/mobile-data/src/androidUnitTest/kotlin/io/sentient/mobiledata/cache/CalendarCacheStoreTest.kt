package io.sentient.mobiledata.cache

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.RecurrenceFrequency
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CalendarCacheStoreTest {
    @Test
    fun `complete replacement emits once and preserves raw V2 temporal identity`() = runTest {
        val fixture = Fixture()
        try {
            val initial = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window))
            assertNull(initial.value)

            val initialFlow = fixture.store.observeSnapshot(fixture.window).first()
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(initialFlow).value)
            val firstObserved = CompletableDeferred<Unit>()
            val observations = async(start = CoroutineStart.UNDISPATCHED) {
                fixture.store.observeSnapshot(fixture.window).take(2).onEach { firstObserved.complete(Unit) }.toList()
            }
            firstObserved.await()
            val occurrence = timedOccurrence()
            val replacement = fixture.store.replaceSnapshot(
                window = fixture.window,
                occurrences = listOf(occurrence),
                fetchedAt = 10L,
                lastAccessedAt = 11L,
            )
            assertIs<CalendarCacheResult.Success<Unit>>(replacement)

            val values = observations.await()
            assertEquals(2, values.size)
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(values[0]).value)
            val snapshot = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(values[1]).value
            assertEquals(10L, snapshot?.fetchedAt)
            assertEquals(11L, snapshot?.lastAccessedAt)
            assertEquals(occurrence, snapshot?.occurrences?.single())
            assertEquals("2026-06-14T09:30:00-07:00", snapshot?.occurrences?.single()?.originalStart)
            assertEquals("2026-06-14T10:30:00-06:00", snapshot?.occurrences?.single()?.start)
            assertEquals("2026-06-14T11:30:00-06:00", snapshot?.occurrences?.single()?.end)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `concurrent replacements never pair metadata with another generation rows`() = runTest {
        val fixture = Fixture()
        try {
            val initialReady = CompletableDeferred<Unit>()
            val firstCommitted = CompletableDeferred<Unit>()
            val observations = async(start = CoroutineStart.UNDISPATCHED) {
                fixture.store.observeSnapshot(fixture.window)
                    .onEach { result ->
                        if (result is CalendarCacheResult.Success) {
                            if (result.value == null) initialReady.complete(Unit) else firstCommitted.complete(Unit)
                        }
                    }
                    .take(3)
                    .toList()
            }
            initialReady.await()

            // Start both callers before releasing either one. The first write
            // is allowed to reach the observer before the second write starts;
            // this removes scheduler-dependent coalescing while still testing
            // concurrent callers against the same replacement window.
            val firstRelease = CompletableDeferred<Unit>()
            val secondRelease = CompletableDeferred<Unit>()
            val firstWrite = async(start = CoroutineStart.UNDISPATCHED) {
                firstRelease.await()
                assertIs<CalendarCacheResult.Success<Unit>>(
                    fixture.store.replaceSnapshot(
                        fixture.window,
                        listOf(timedOccurrence(eventId = "generation-101", occurrenceId = "occurrence-101")),
                        fetchedAt = 101L,
                        lastAccessedAt = 101L,
                    ),
                )
            }
            val secondWrite = async(start = CoroutineStart.UNDISPATCHED) {
                secondRelease.await()
                assertIs<CalendarCacheResult.Success<Unit>>(
                    fixture.store.replaceSnapshot(
                        fixture.window,
                        listOf(timedOccurrence(eventId = "generation-202", occurrenceId = "occurrence-202")),
                        fetchedAt = 202L,
                        lastAccessedAt = 202L,
                    ),
                )
            }
            firstRelease.complete(Unit)
            firstCommitted.await()
            secondRelease.complete(Unit)
            firstWrite.await()
            secondWrite.await()

            val committed = observations.await().drop(1).map { result ->
                assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(result).value
                    ?: error("committed replacement was unexpectedly absent")
            }
            assertEquals(setOf(101L, 202L), committed.map { it.fetchedAt }.toSet())
            committed.forEach { snapshot ->
                assertEquals(1, snapshot.occurrences.size)
                assertEquals("generation-${snapshot.fetchedAt}", snapshot.occurrences.single().eventId)
            }
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `invalid replacement does not replace the previous complete snapshot`() = runTest {
        val fixture = Fixture()
        try {
            val original = timedOccurrence(eventId = "old-event", occurrenceId = "old-occurrence")
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.replaceSnapshot(fixture.window, listOf(original), fetchedAt = 1L),
            )

            val failure = assertIs<CalendarCacheResult.Failure>(
                fixture.store.replaceSnapshot(
                    fixture.window,
                    listOf(original, original),
                    fetchedAt = 2L,
                ),
            )
            assertEquals(CalendarCacheFailureReason.INVALID_SNAPSHOT, failure.error.reason)
            val retained = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value
            assertEquals(listOf(original), retained?.occurrences)
            assertEquals(1L, retained?.fetchedAt)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `database failure during replacement rolls back the previous complete snapshot`() = runTest {
        val fixture = Fixture()
        try {
            val original = timedOccurrence(eventId = "old-event", occurrenceId = "old-occurrence")
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.replaceSnapshot(fixture.window, listOf(original), fetchedAt = 1L),
            )
            fixture.driver.execute(
                null,
                """
                CREATE TRIGGER fail_calendar_occurrence_insert
                BEFORE INSERT ON calendar_occurrence
                BEGIN
                  SELECT RAISE(ABORT, 'synthetic failure');
                END
                """.trimIndent(),
                0,
            )

            val failure = assertIs<CalendarCacheResult.Failure>(
                fixture.store.replaceSnapshot(
                    fixture.window,
                    listOf(original.copy(eventId = "new-event", occurrenceId = "new-occurrence")),
                    fetchedAt = 2L,
                ),
            )
            assertEquals(CalendarCacheFailureReason.DATABASE, failure.error.reason)
            val retained = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value
            assertEquals(listOf(original), retained?.occurrences)
            assertEquals(1L, retained?.fetchedAt)
        } finally {
            fixture.driver.execute(null, "DROP TRIGGER IF EXISTS fail_calendar_occurrence_insert", 0)
            fixture.close()
        }
    }

    @Test
    fun `preferences round trip supported controls and retain absent facets`() = runTest {
        val fixture = Fixture()
        try {
            val preferences = CalendarCachePreferences(
                view = io.sentient.mobiledata.calendar.CalendarView.WEEK,
                anchorDate = "2026-06-14",
                scopes = listOf(CalendarScope.PRIVATE, CalendarScope.HOUSEHOLD),
                groups = listOf("Absent group", "Family"),
                tags = listOf("old-tag", "meal"),
                importance = Importance.IMPORTANT,
                searchText = "breakfast query",
                updatedAt = 22L,
            )
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.writePreferences(preferences))
            val observed = assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(fixture.store.readPreferences()).value
            assertEquals(preferences.copy(groups = listOf("Absent group", "Family"), tags = listOf("meal", "old-tag")), observed)

            val initialPreference = fixture.store.observePreferences().first()
            assertEquals(
                preferences.copy(tags = listOf("meal", "old-tag")),
                assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(initialPreference).value,
            )
            val firstPreferenceObserved = CompletableDeferred<Unit>()
            val preferenceFlow = async(start = CoroutineStart.UNDISPATCHED) {
                fixture.store.observePreferences().take(2).onEach { firstPreferenceObserved.complete(Unit) }.toList()
            }
            firstPreferenceObserved.await()
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.writePreferences(preferences.copy(view = io.sentient.mobiledata.calendar.CalendarView.YEAR, updatedAt = 23L)),
            )
            val emissions = preferenceFlow.await()
            assertEquals(2, emissions.size)
            assertEquals(io.sentient.mobiledata.calendar.CalendarView.YEAR, assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(emissions.last()).value?.view)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `namespace switch and purge isolate rows and preferences`() = runTest {
        val fixture = Fixture()
        try {
            val value = timedOccurrence()
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.replaceSnapshot(fixture.window, listOf(value), fetchedAt = 1L))
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.writePreferences(CalendarCachePreferences(anchorDate = "2026-06-14", searchText = "private text")),
            )

            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.switchNamespace(CalendarCacheNamespace("account-b", "backend-a"), purgePrevious = false),
            )
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value)
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(fixture.store.readPreferences()).value)
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.replaceSnapshot(fixture.window, listOf(value.copy(eventId = "other")), fetchedAt = 2L))

            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.switchNamespace(CalendarCacheNamespace("account-a", "backend-a"), purgePrevious = false),
            )
            assertEquals(listOf(value), assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value?.occurrences)
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.purgeNamespace())
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value)
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCachePreferences?>>(fixture.store.readPreferences()).value)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `namespace pinned writes reject a predecessor completion after switch`() = runTest {
        val fixture = Fixture()
        try {
            val original = timedOccurrence()
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.replaceSnapshot(fixture.window, listOf(original), fetchedAt = 1L),
            )
            val predecessor = fixture.store.currentNamespace.value
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.switchNamespace(CalendarCacheNamespace("account-b", "backend-a"), purgePrevious = true),
            )

            val result = fixture.store.replaceSnapshotForNamespace(
                namespace = predecessor,
                window = fixture.window,
                occurrences = listOf(original.copy(eventId = "predecessor")),
                fetchedAt = 2L,
            )
            val failure = assertIs<CalendarCacheResult.Failure>(result)
            assertEquals(CalendarCacheFailureReason.INVALID_NAMESPACE, failure.error.reason)
            assertNull(assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `access and freshness metadata update without changing occurrences`() = runTest {
        val fixture = Fixture()
        try {
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.replaceSnapshot(fixture.window, listOf(timedOccurrence()), fetchedAt = 4L, lastAccessedAt = 5L))
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.markAccessed(fixture.window, 9L))
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.markFreshness(fixture.window, CalendarCacheFreshness.STALE))
            val snapshot = assertIs<CalendarCacheResult.Success<CalendarCacheSnapshot?>>(fixture.store.readSnapshot(fixture.window)).value
            assertEquals(9L, snapshot?.lastAccessedAt)
            assertEquals(CalendarCacheFreshness.STALE, snapshot?.freshness)
            assertEquals(1, snapshot?.occurrences?.size)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `retention evicts oldest complete windows but protects active window`() = runTest {
        val fixture = Fixture()
        try {
            val namespace = fixture.store.currentNamespace.value
            val windows = (0..12).map(::retentionWindow)
            windows.forEachIndexed { index, window ->
                assertIs<CalendarCacheResult.Success<Unit>>(
                    fixture.store.replaceSnapshotAndRetainForNamespace(
                        namespace = namespace,
                        window = window,
                        occurrences = listOf(timedOccurrence(eventId = "event-$index", occurrenceId = "occurrence-$index")),
                        fetchedAt = (index + 1).toLong(),
                        lastAccessedAt = (index + 1).toLong(),
                        activeWindow = window,
                        maxWindows = 20,
                    ),
                )
            }

            // Make the oldest row the active row. It must not be selected as
            // the eviction victim merely because it is protected by the read.
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.retainRecentWindowsForNamespace(
                    namespace = namespace,
                    activeWindow = windows.first(),
                    maxWindows = 12,
                ),
            )

            val retained = assertIs<CalendarCacheResult.Success<List<CalendarCacheWindowMetadata>>>(fixture.store.readWindows()).value
            assertEquals(12, retained.size)
            assertTrue(retained.any { it.window == windows.first() })
            assertTrue(retained.none { it.window == windows[1] })
            assertEquals(
                (setOf(windows.first()) + windows.drop(2)).toSet(),
                retained.map { it.window }.toSet(),
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `view access updates lru metadata before eviction`() = runTest {
        val fixture = Fixture()
        try {
            val namespace = fixture.store.currentNamespace.value
            val windows = (0..12).map(::retentionWindow)
            windows.forEachIndexed { index, window ->
                assertIs<CalendarCacheResult.Success<Unit>>(
                    fixture.store.replaceSnapshotAndRetainForNamespace(
                        namespace = namespace,
                        window = window,
                        occurrences = listOf(timedOccurrence(eventId = "event-$index", occurrenceId = "occurrence-$index")),
                        fetchedAt = (index + 1).toLong(),
                        lastAccessedAt = (index + 1).toLong(),
                        activeWindow = window,
                        maxWindows = 20,
                    ),
                )
            }
            assertIs<CalendarCacheResult.Success<Unit>>(
                fixture.store.touchAndRetainForNamespace(
                    namespace = namespace,
                    window = windows.first(),
                    lastAccessedAt = 100L,
                    maxWindows = 12,
                ),
            )
            val retained = assertIs<CalendarCacheResult.Success<List<CalendarCacheWindowMetadata>>>(fixture.store.readWindows()).value
            assertEquals(12, retained.size)
            assertTrue(retained.any { it.window == windows.first() && it.lastAccessedAt == 100L })
            assertTrue(retained.none { it.window == windows[1] })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `corrupt payload is a typed failure without partial content`() = runTest {
        val fixture = Fixture()
        try {
            assertIs<CalendarCacheResult.Success<Unit>>(fixture.store.replaceSnapshot(fixture.window, listOf(timedOccurrence()), fetchedAt = 1L))
            fixture.driver.execute(
                null,
                "UPDATE calendar_occurrence SET payload_json = '{broken}' WHERE account_id = 'account-a'",
                0,
            )
            val failure = assertIs<CalendarCacheResult.Failure>(fixture.store.readSnapshot(fixture.window))
            assertEquals(CalendarCacheFailureReason.DECODE, failure.error.reason)
            assertTrue("Breakfast" !in failure.toString())
            assertTrue("query" !in failure.toString())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `close cancels observation and rejects later operations`() = runTest {
        val fixture = Fixture()
        val observation = async {
            fixture.store.observeSnapshot(fixture.window).collect {
                awaitCancellation()
            }
        }
        observation.cancelAndJoin()
        fixture.store.close()
        val failure = assertIs<CalendarCacheResult.Failure>(fixture.store.readSnapshot(fixture.window))
        assertEquals(CalendarCacheFailureReason.CLOSED, failure.error.reason)
        assertTrue(fixture.store.isClosed)
        fixture.close()
    }

    private class Fixture {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        private val handle = openCalendarDatabase {
            CalendarDatabase.Schema.create(driver)
            driver
        }
        val store: CalendarCacheStore = createCalendarCacheStore(
            handle = handle,
            namespace = CalendarCacheNamespace("account-a", "backend-a"),
            observationContext = Dispatchers.Unconfined,
        )
        val window = CalendarCacheWindow(
            windowStart = "2026-06-01",
            windowEnd = "2026-07-01",
            timezoneInput = "America/Los_Angeles",
        )

        fun close() {
            store.close()
            // The store owns the handle; this is only a safety net for a failed open.
        }
    }

    private fun retentionWindow(index: Int): CalendarCacheWindow {
        val year = 2026 + index / 12
        val month = index % 12 + 1
        val nextYear = if (month == 12) year + 1 else year
        val nextMonth = if (month == 12) 1 else month + 1
        return CalendarCacheWindow(
            windowStart = "%04d-%02d-01".format(year, month),
            windowEnd = "%04d-%02d-01".format(nextYear, nextMonth),
            timezoneInput = "America/Los_Angeles",
        )
    }

    private fun timedOccurrence(
        eventId: String = "event-1",
        occurrenceId: String = "occurrence-1",
    ) = EffectiveOccurrence(
        eventId = eventId,
        occurrenceId = occurrenceId,
        originalStart = "2026-06-14T09:30:00-07:00",
        recurring = true,
        revision = 7,
        scope = CalendarScope.HOUSEHOLD,
        title = "Breakfast",
        description = "Private description",
        start = "2026-06-14T10:30:00-06:00",
        end = "2026-06-14T11:30:00-06:00",
        visibility = Visibility.EVERYONE,
        importance = Importance.IMPORTANT,
        group = "Family",
        tags = listOf("meal", "old-tag"),
        recurrence = StructuredRecurrence(
            frequency = RecurrenceFrequency.WEEKLY,
            interval = 1,
        ),
    )
}
