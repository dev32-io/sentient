package io.sentient.mobiledata.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheReadResult
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheSnapshot
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.cache.CalendarCacheWindowMetadata
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarExperienceTest {
    @Test
    fun `cached content is observable before delayed remote and remains through refresh`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "fresh"))),
            beforePage = { gate.await() },
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            runCurrent()

            assertEquals("cached", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertTrue(experience.state.value.hasCompleteCache)
            assertEquals(CalendarLoadingPhase.REFRESHING, experience.state.value.loading.phase)
            assertEquals(CalendarScope.ALL, repository.scopes.single())
            assertEquals(1, repository.calls)

            gate.complete(Unit)
            advanceUntilIdle()

            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(1, cache.replacements)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `all pages aggregate and duplicate stable occurrences are committed once`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore()
        val duplicate = event(title = "old", revision = 1)
        val replacement = duplicate.copy(title = "new", revision = 2)
        val repository = FakeRepository(
            pages = listOf(
                page(duplicate, nextCursor = "page-2"),
                page(replacement, event(id = "second", title = "second")),
            ),
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertEquals(2, repository.calls)
            assertEquals(listOf("new", "second"), cache.snapshot?.occurrences?.map { it.title })
            assertEquals(1, cache.replacements)
            assertTrue(repository.scopes.all { it == CalendarScope.ALL })
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `later page failure leaves the old complete snapshot intact`() = runTest {
        val window = monthWindow()
        val old = snapshot(window, title = "old")
        val cache = FakeCacheStore(snapshot = old)
        val repository = FakeRepository(
            pages = listOf(
                page(event(title = "new"), nextCursor = "page-2"),
                SentientResult.Failure(SentientError.Connection("offline")),
            ),
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertEquals(0, cache.replacements)
            assertEquals(old, cache.snapshot)
            assertEquals("old", experience.state.value.authorizedOccurrences.single().title)
            assertEquals(CalendarExperienceErrorKind.CONNECTION, experience.state.value.error?.kind)
            assertEquals(CalendarFreshness.CACHED_OFFLINE, experience.state.value.freshness)
            assertEquals(CalendarOfflineState.OFFLINE, experience.state.value.offline)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `cursor loop is typed contract failure and does not fall back as offline`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "old"))
        val repository = FakeRepository(
            pages = listOf(
                page(event(title = "first"), nextCursor = "loop"),
                page(event(title = "second"), nextCursor = "loop"),
            ),
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertEquals(0, cache.replacements)
            assertEquals(CalendarExperienceErrorKind.CONTRACT, experience.state.value.error?.kind)
            assertEquals(CalendarFreshness.ERROR, experience.state.value.freshness)
            assertEquals(CalendarOfflineState.ONLINE, experience.state.value.offline)
            assertEquals("old", experience.state.value.authorizedOccurrences.single().title)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `equivalent foreground requests coalesce while obsolete request is cancelled`() = runTest {
        val firstWindow = monthWindow()
        val secondWindow = CalendarCacheWindow("2026-07-01", "2026-08-01")
        val cache = FakeCacheStore()
        val firstGate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "new"))),
            beforePage = { firstGate.await() },
        )
        val experience = experience(repository, cache, firstWindow, this)
        try {
            experience.observe(firstWindow)
            experience.observe(firstWindow)
            runCurrent()
            assertEquals(1, repository.calls)

            experience.observe(secondWindow)
            runCurrent()
            assertTrue(repository.cancelled)
            assertTrue(repository.calls >= 2)
            firstGate.complete(Unit)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `persisted preferences are validated and restored before revalidation`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(
            preferences = CalendarCachePreferences(
                view = CalendarView.DAY,
                anchorDate = "2026-06-14",
                scopes = listOf(CalendarScope.ALL),
                groups = listOf("family"),
                updatedAt = 7L,
            ),
        )
        val repository = FakeRepository(pages = listOf(page(event(group = "family"))))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertEquals(CalendarView.DAY, experience.state.value.view)
            assertEquals("2026-06-14", experience.state.value.anchorDate)
            assertEquals(setOf("family"), experience.state.value.filters.groups)
            assertEquals(CalendarScope.ALL, repository.scopes.single())
        } finally {
            experience.close()
        }
    }

    @Test
    fun `filter intent recomputes locally and does not issue a filtered request`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(
            snapshot = snapshot(
                window,
                occurrences = listOf(
                    occurrence("one", title = "Family lunch", group = "family"),
                    occurrence("two", title = "Work", group = "work"),
                ),
            ),
        )
        val repository = FakeRepository(
            pages = listOf(
                page(
                    event(id = "one", title = "Family lunch", group = "family"),
                    event(id = "two", title = "Work", group = "work"),
                ),
            ),
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            val calls = repository.calls

            experience.setFilters(CalendarFilters(groups = setOf("family")))
            advanceUntilIdle()

            assertEquals(calls, repository.calls)
            assertEquals(listOf("Family lunch"), experience.state.value.projection?.filteredOccurrences?.map { it.title })
            assertEquals(listOf("family", "work"), experience.state.value.projection?.facets?.groups)
            assertTrue(cache.writtenPreferences.isNotEmpty())
        } finally {
            experience.close()
        }
    }

    @Test
    fun `source compatible SettingsComponent can inject the optional experience`() = runTest {
        val cache = FakeCacheStore()
        val experience = experience(
            repository = FakeRepository(pages = listOf(page(event()))),
            cache = cache,
            window = monthWindow(),
            scope = this,
        )
        try {
            val component = SettingsComponent(
                httpClient = HttpClient(MockEngine { respondOk() }),
                gatewayWsUrl = "ws://localhost",
                token = { "token" },
                calendarExperience = experience,
            )
            assertTrue(component.calendarExperience === experience)
            assertTrue(component.experience === experience)
            assertNotNull(CalendarExperienceFactory { error("factory is not invoked") })
        } finally {
            experience.close()
        }
    }

    private fun experience(
        repository: CalendarRepository,
        cache: FakeCacheStore,
        window: CalendarCacheWindow,
        scope: CoroutineScope,
    ) = CalendarExperience(
        repository = repository,
        cacheStore = cache,
        scope = scope,
        initialWindow = window,
        initialAnchorDate = "2026-06-14",
        nowMillis = { 100L },
        todayDate = { "2026-06-14" },
    )

    private fun monthWindow() = CalendarCacheWindow("2026-06-01", "2026-07-01")

    private fun snapshot(
        window: CalendarCacheWindow,
        title: String = "cached",
        occurrences: List<EffectiveOccurrence> = listOf(occurrence("cached", title)),
    ) = CalendarCacheSnapshot(
        window = window,
        occurrences = occurrences,
        fetchedAt = 1L,
        lastAccessedAt = 1L,
        freshness = CalendarCacheFreshness.FRESH,
    )

    private fun page(vararg events: CalendarEvent, nextCursor: String? = null) =
        SentientResult.Success(CalendarEventPage(events.toList(), nextCursor = nextCursor))

    private fun event(
        id: String = "event",
        title: String = "Event",
        group: String? = null,
        revision: Int = 1,
    ) = CalendarEvent(
        id = id,
        scope = CalendarScope.HOUSEHOLD,
        title = title,
        start = CalendarTime.AllDay("2026-06-14"),
        end = CalendarTime.AllDay("2026-06-15"),
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
        group = group,
        revision = revision,
        occurrenceId = "occurrence-$id",
        originalStart = CalendarTime.AllDay("2026-06-14"),
    )

    private fun occurrence(
        id: String,
        title: String,
        group: String? = null,
    ) = EffectiveOccurrence(
        eventId = "event-$id",
        occurrenceId = "occurrence-$id",
        originalStart = "2026-06-14",
        recurring = false,
        revision = 1,
        scope = CalendarScope.HOUSEHOLD,
        title = title,
        start = "2026-06-14",
        end = "2026-06-15",
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
        group = group,
    )

    private class FakeRepository(
        private val pages: List<SentientResult<CalendarEventPage>>,
        private val beforePage: (suspend () -> Unit)? = null,
    ) : CalendarRepository {
        var calls: Int = 0
        var cancelled: Boolean = false
        val scopes = mutableListOf<CalendarScope?>()

        override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?) =
            SentientResult.Failure(SentientError.Unknown("unused"))

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
        ): SentientResult<CalendarEventPage> {
            calls++
            scopes += scope
            try {
                beforePage?.invoke()
            } catch (cancelled: CancellationException) {
                this.cancelled = true
                throw cancelled
            }
            return pages.getOrElse(calls - 1) { pages.last() }
        }

        override suspend fun create(event: CalendarEvent) = error("unused")
        override suspend fun create(input: CalendarCreateInput) = error("unused")
        override suspend fun mutate(eventId: String, command: CalendarMutationCommand): SentientResult<CalendarMutationResult> =
            error("unused")
    }

    private class FakeCacheStore(
        snapshot: CalendarCacheSnapshot? = null,
        preferences: CalendarCachePreferences? = null,
    ) : CalendarCacheStore {
        override val currentNamespace = MutableStateFlow(CalendarCacheNamespace("account", "backend")).asStateFlow()
        override val isClosed: Boolean = false
        private val snapshotState = MutableStateFlow<CalendarCacheReadResult<CalendarCacheSnapshot?>>(CalendarCacheResult.Success(snapshot))
        private val preferencesState = MutableStateFlow<CalendarCacheReadResult<CalendarCachePreferences?>>(CalendarCacheResult.Success(preferences))
        var snapshot: CalendarCacheSnapshot? = snapshot
        var replacements: Int = 0
        val writtenPreferences = mutableListOf<CalendarCachePreferences>()

        override fun observeSnapshot(window: CalendarCacheWindow): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> = snapshotState
        override suspend fun readSnapshot(window: CalendarCacheWindow) = snapshotState.value
        override suspend fun replaceSnapshot(snapshot: CalendarCacheSnapshot): CalendarCacheResult<Unit> = replaceSnapshot(
            snapshot.window,
            snapshot.occurrences,
            snapshot.fetchedAt,
            snapshot.lastAccessedAt,
            snapshot.freshness,
        )

        override suspend fun replaceSnapshot(
            window: CalendarCacheWindow,
            occurrences: List<EffectiveOccurrence>,
            fetchedAt: Long,
            lastAccessedAt: Long,
            freshness: CalendarCacheFreshness,
        ): CalendarCacheResult<Unit> {
            replacements++
            snapshot = CalendarCacheSnapshot(window, occurrences, fetchedAt, lastAccessedAt, freshness)
            snapshotState.value = CalendarCacheResult.Success(snapshot)
            return CalendarCacheResult.Success(Unit)
        }

        override fun observePreferences() = preferencesState
        override suspend fun readPreferences() = preferencesState.value
        override suspend fun writePreferences(preferences: CalendarCachePreferences): CalendarCacheResult<Unit> {
            writtenPreferences += preferences
            preferencesState.value = CalendarCacheResult.Success(preferences)
            return CalendarCacheResult.Success(Unit)
        }

        override suspend fun writePreferences(preferences: CalendarPreferences, updatedAt: Long): CalendarCacheResult<Unit> =
            writePreferences(
                CalendarCachePreferences(
                    view = preferences.view,
                    anchorDate = preferences.anchorDate,
                    scopes = listOf(preferences.filters.scope),
                    groups = preferences.filters.groups.toList(),
                    tags = preferences.filters.tags.toList(),
                    importance = preferences.filters.importance,
                    searchText = preferences.filters.text,
                    updatedAt = updatedAt,
                ),
            )

        override fun observeWindows(): Flow<CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>> =
            MutableStateFlow<CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>>(CalendarCacheResult.Success(emptyList()))
        override suspend fun readWindows() = CalendarCacheResult.Success(emptyList<CalendarCacheWindowMetadata>())
        override suspend fun markAccessed(window: CalendarCacheWindow, lastAccessedAt: Long) = CalendarCacheResult.Success(Unit)
        override suspend fun markFreshness(window: CalendarCacheWindow, freshness: CalendarCacheFreshness) = CalendarCacheResult.Success(Unit)
        override suspend fun purgeNamespace(namespace: CalendarCacheNamespace) = CalendarCacheResult.Success(Unit)
        override suspend fun switchNamespace(namespace: CalendarCacheNamespace, purgePrevious: Boolean) = CalendarCacheResult.Success(Unit)
        override fun close() = Unit
    }
}
