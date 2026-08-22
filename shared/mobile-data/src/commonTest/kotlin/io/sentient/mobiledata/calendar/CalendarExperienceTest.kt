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
import io.sentient.mobilesdk.calendar.CalendarMutationScope
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
import kotlinx.coroutines.launch
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
            assertTrue(repository.scopes.all { it == CalendarScope.ALL })
            assertTrue(repository.calls >= 1)

            gate.complete(Unit)
            advanceUntilIdle()

            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertTrue(cache.replacements >= 1)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `adjacent prefetch is asynchronous and coalesces the visible month`() = runTest {
        val window = monthWindow()
        val previous = CalendarCacheWindow("2026-05-01", "2026-06-01")
        val next = CalendarCacheWindow("2026-07-01", "2026-08-01")
        val gate = CompletableDeferred<Unit>()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val repository = FakeRepository(
            pages = listOf(page(event(title = "fresh"))),
            beforePage = { gate.await() },
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            runCurrent()

            assertEquals("cached", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertTrue(experience.isPrefetching)
            assertTrue(repository.windows.contains(window.windowStart to window.windowEnd))
            assertTrue(repository.windows.contains(previous.windowStart to previous.windowEnd))
            assertTrue(repository.windows.contains(next.windowStart to next.windowEnd))
            assertEquals(1, repository.windows.count { it == (window.windowStart to window.windowEnd) })

            gate.complete(Unit)
            advanceUntilIdle()

            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertNotNull(cache.snapshotFor(previous))
            assertNotNull(cache.snapshotFor(next))
        } finally {
            experience.close()
        }
    }

    @Test
    fun `fast adjacent completions stay registered and coalesce duplicate prefetch calls`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val repository = FakeRepository(pages = listOf(page(event(title = "remote"))))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            experience.prefetchAdjacent(window)
            experience.prefetchAdjacent(window)
            advanceUntilIdle()

            val grouped = repository.windows.groupingBy { it }.eachCount()
            assertTrue(grouped.values.all { it == 1 }, grouped.toString())
        } finally {
            experience.close()
        }
    }

    @Test
    fun `prefetch failure remains a sanitized diagnostic and does not fail visible data`() = runTest {
        val window = monthWindow()
        val failures = setOf(
            "2026-05-01" to "2026-06-01",
            "2026-07-01" to "2026-08-01",
        )
        val cache = FakeCacheStore()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "visible"))),
            failureWindows = failures,
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertEquals("visible", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(null, experience.state.value.error)
            assertEquals(
                failures,
                experience.prefetchDiagnostics.value.map { it.window.windowStart to it.window.windowEnd }.toSet(),
            )
            assertTrue(experience.prefetchDiagnostics.value.all { it.kind == CalendarPrefetchFailureKind.CONNECTION })
        } finally {
            experience.close()
        }
    }

    @Test
    fun `cached offline navigation is usable and recovery revalidates an unavailable interval`() = runTest {
        val window = monthWindow()
        val previous = CalendarCacheWindow("2026-05-01", "2026-06-01")
        val uncached = CalendarCacheWindow("2027-01-01", "2027-02-01")
        val cache = FakeCacheStore()
        val repository = FakeRepository(pages = listOf(page(event(title = "remote"))))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            repository.offline = true

            experience.observe(previous)
            advanceUntilIdle()
            assertTrue(experience.state.value.hasCompleteCache)
            assertEquals(CalendarOfflineState.OFFLINE, experience.state.value.offline)
            assertEquals(CalendarFreshness.CACHED_OFFLINE, experience.state.value.freshness)
            assertEquals("remote", experience.state.value.authorizedOccurrences.single().title)

            experience.observe(uncached)
            advanceUntilIdle()
            assertTrue(!experience.state.value.hasCompleteCache)
            assertEquals(CalendarOfflineState.UNAVAILABLE, experience.state.value.offline)
            assertEquals(CalendarFreshness.UNAVAILABLE_OFFLINE, experience.state.value.freshness)
            assertEquals(CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE, experience.state.value.error?.kind)
            assertTrue(experience.state.value.isUnavailableOffline)

            repository.offline = false
            experience.onConnectivityRecovered()
            advanceUntilIdle()
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(CalendarOfflineState.ONLINE, experience.state.value.offline)
            assertEquals(null, experience.state.value.error)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `auth expiry purges private cache and closes the experience`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "private"))
        val repository = FakeRepository(
            pages = listOf(page(event(title = "should not persist"))),
            authFailure = true,
        )
        val experience = experience(repository, cache, window, this)
        experience.observe(window)
        advanceUntilIdle()

        assertTrue(experience.isClosed)
        assertTrue(experience.state.value.authorizedOccurrences.isEmpty())
        assertEquals(null, cache.snapshotFor(window))
    }

    @Test
    fun `forbidden refresh clears projection before purging inaccessible cache`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "private"))
        val repository = FakeRepository(
            pages = listOf(page(event(title = "must not remain visible"))),
            forbiddenFailure = true,
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()

            assertTrue(experience.state.value.authorizedOccurrences.isEmpty())
            assertEquals(null, experience.state.value.projection)
            assertEquals(CalendarExperienceErrorKind.FORBIDDEN, experience.state.value.error?.kind)
            assertEquals(null, cache.snapshotFor(window))
            assertTrue(experience.state.value.mutationAvailability.reason == CalendarMutationAvailabilityReason.AUTHORIZATION)
            assertTrue(experience.refresh() == null)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `mutation auth failure purges cache and closes the expired boundary`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "private"))
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Failure(SentientError.Auth("expired", terminal = true)),
        )
        val experience = experience(repository, cache, window, this)
        experience.observe(window)
        advanceUntilIdle()
        experience.editOccurrence(occurrence("auth-target", title = "draft target"))
        experience.submitMutation()
        advanceUntilIdle()

        assertEquals(1, repository.mutationCalls)
        assertTrue(experience.isClosed)
        assertTrue(experience.state.value.authorizedOccurrences.isEmpty())
        assertEquals(null, cache.snapshotFor(window))
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

            assertTrue(repository.calls >= 2)
            assertEquals(listOf("new", "second"), cache.snapshotFor(window)?.occurrences?.map { it.title })
            assertTrue(cache.replacements >= 1)
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
            assertTrue(repository.calls >= 1)

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
    fun `cancel then immediate same-key observation starts a fresh request`() = runTest {
        val window = monthWindow()
        val otherWindow = CalendarCacheWindow("2026-07-01", "2026-08-01")
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "fresh"))),
            beforePage = { gate.await() },
        )
        val experience = experience(repository, FakeCacheStore(), window, this)
        try {
            experience.observe(window)
            runCurrent()
            assertEquals(1, repository.windows.count { it == (window.windowStart to window.windowEnd) })

            // The second observation synchronously removes/cancels the first
            // request. Returning to the original key must not join it.
            experience.observe(otherWindow)
            runCurrent()
            experience.observe(window)
            runCurrent()

            assertTrue(
                repository.windows.count { it == (window.windowStart to window.windowEnd) } >= 2,
                repository.windows.toString(),
            )
            assertTrue(repository.cancelled)

            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `namespace switch away and back does not reuse the predecessor request`() = runTest {
        val window = monthWindow()
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "fresh"))),
            beforePage = { gate.await() },
        )
        val experience = experience(repository, FakeCacheStore(), window, this)
        try {
            experience.observe(window)
            runCurrent()
            val successor = CalendarCacheNamespace("account-b", "backend-b")
            assertIs<CalendarCacheResult.Success<Unit>>(experience.switchNamespace(successor))
            runCurrent()
            assertIs<CalendarCacheResult.Success<Unit>>(
                experience.switchNamespace(CalendarCacheNamespace("account", "backend")),
            )
            runCurrent()

            // A -> B -> A uses the same request key on the final switch. The
            // cancelled A entry must already be absent before that lookup.
            assertEquals(3, repository.windows.count { it == (window.windowStart to window.windowEnd) })

            gate.complete(Unit)
            advanceUntilIdle()
        } finally {
            experience.close()
        }
    }

    @Test
    fun `old request completion cannot erase a newer same-key registration`() = runTest {
        val window = monthWindow()
        val otherWindow = CalendarCacheWindow("2026-07-01", "2026-08-01")
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "fresh"))),
            beforePage = { gate.await() },
            swallowCancellation = true,
        )
        val experience = experience(repository, FakeCacheStore(), window, this)
        try {
            experience.observe(window)
            runCurrent()
            experience.observe(otherWindow)
            experience.observe(window)
            runCurrent()

            // The predecessor is cancellation-resistant and may finish after
            // the replacement has been registered. Its identity-checked
            // completion must not remove the replacement entry.
            assertTrue(
                repository.windows.count { it == (window.windowStart to window.windowEnd) } >= 2,
                repository.windows.toString(),
            )
            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `concurrent adjacent prefetch requests coalesce at the registry boundary`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window))
        val repository = FakeRepository(pages = listOf(page(event(title = "remote"))))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            val callers = List(16) {
                launch {
                    experience.prefetchAdjacent(window).single().join()
                }
            }
            callers.forEach { it.join() }
            advanceUntilIdle()

            val grouped = repository.windows.groupingBy { it }.eachCount()
            assertTrue(grouped.values.all { it == 1 }, grouped.toString())
        } finally {
            experience.close()
        }
    }

    @Test
    fun `namespace switch clears visible state and rejects a cancelled predecessor completion`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(
            snapshot = snapshot(window, title = "old cached"),
        )
        val oldRemoteGate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "old remote")), page(event(title = "new remote"))),
            beforePage = { oldRemoteGate.await() },
            swallowCancellation = true,
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            runCurrent()
            assertEquals("old cached", experience.state.value.projection?.visibleEvents?.single()?.title)

            val successor = CalendarCacheNamespace("account-b", "backend-b")
            assertIs<CalendarCacheResult.Success<Unit>>(experience.switchNamespace(successor))
            assertTrue(experience.state.value.authorizedOccurrences.isEmpty())
            assertEquals(null, experience.state.value.projection)
            assertEquals(null, experience.state.value.persistedCachePreferences)
            assertTrue(!experience.state.value.hasCompleteCache)

            oldRemoteGate.complete(Unit)
            advanceUntilIdle()

            assertEquals("new remote", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertEquals(successor, cache.currentNamespace.value)
            assertTrue(cache.replacementNamespaces.all { it == successor })
        } finally {
            experience.close()
        }
    }

    @Test
    fun `cancelled mutation completion cannot enter successor namespace`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "old"))
        val mutationGate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            beforeMutation = { mutationGate.await() },
            swallowMutationCancellation = true,
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            experience.editOccurrence(occurrence("old-target", title = "draft target"))
            experience.submitMutation()
            runCurrent()

            val successor = CalendarCacheNamespace("account-successor", "backend-successor")
            assertIs<CalendarCacheResult.Success<Unit>>(experience.switchNamespace(successor))
            assertTrue(experience.state.value.authorizedOccurrences.isEmpty() ||
                experience.state.value.authorizedOccurrences.all { it.title != "old" })

            mutationGate.complete(Unit)
            advanceUntilIdle()

            assertTrue(repository.mutationCancelled)
            assertTrue(experience.state.value.mutation.outcome == null)
            assertTrue(cache.replacementNamespaces.dropWhile { it != successor }.all { it == successor })
        } finally {
            experience.close()
        }
    }

    @Test
    fun `timezone-only locale changes use a distinct cache identity and revalidate`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore()
        val repository = FakeRepository(pages = listOf(page(event())))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            val initialCalls = repository.calls

            experience.setLocale(CalendarLocale(timeZoneId = "America/Los_Angeles"))
            advanceUntilIdle()

            assertTrue(repository.calls > initialCalls)
            assertEquals("America/Los_Angeles", experience.visibleWindow.timezoneInput)
            assertEquals("America/Los_Angeles", cache.snapshotFor(experience.visibleWindow)?.window?.timezoneInput)
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
            assertTrue(repository.scopes.all { it == CalendarScope.ALL })
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
    fun `editor draft validation uses the same command builders as submission`() {
        val create = CalendarMutationEditorState(
            CalendarMutationEditorMode.CREATE,
            CalendarMutationDraft.create(start = "2026-06-14", title = "Dinner"),
        )
        assertTrue(create.canSubmitDraft)
        assertTrue(!create.copy(draft = create.draft.copy(title = "  ")).canSubmitDraft)

        val recurring = occurrence("valid", "Dinner").copy(recurring = true)
        val draft = CalendarMutationDraft.fromOccurrence(recurring)
        val edit = CalendarMutationEditorState(
            CalendarMutationEditorMode.EDIT,
            draft,
            target = CalendarMutationTarget.fromOccurrence(recurring),
            applicableScopes = CalendarMutationScope.entries,
            selectedScope = null,
        )
        assertTrue(!edit.canSubmitDraft)
        assertTrue(edit.copy(selectedScope = CalendarMutationScope.THIS_OCCURRENCE).canSubmitDraft)
    }

    @Test
    fun `submitting ignores draft scope delete dismissal and duplicate submit intents`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            beforeMutation = { gate.await() },
        )
        val experience = experience(repository, FakeCacheStore(), monthWindow(), this)
        try {
            val recurring = occurrence("race", "Original").copy(recurring = true)
            experience.editOccurrence(recurring)
            experience.chooseMutationScope(CalendarMutationScope.THIS_OCCURRENCE)
            val submittedDraft = experience.state.value.mutation.draft!!.copy(title = "Submitted")
            experience.updateDraft(submittedDraft)
            experience.submitMutation()
            runCurrent()

            assertEquals(CalendarMutationPhase.SUBMITTING, experience.state.value.mutation.phase)
            assertEquals(1, repository.mutationCalls)

            experience.updateDraft(submittedDraft.copy(title = "Racing edit"))
            experience.chooseMutationScope(CalendarMutationScope.THIS_AND_FOLLOWING)
            experience.requestDelete()
            experience.cancelMutation()
            experience.submitMutation(submittedDraft.copy(title = "Duplicate"))

            val mutation = experience.state.value.mutation
            assertEquals(CalendarMutationPhase.SUBMITTING, mutation.phase)
            assertEquals("Submitted", mutation.draft?.title)
            assertEquals(CalendarMutationScope.THIS_OCCURRENCE, mutation.editor?.selectedScope)
            assertEquals(null, mutation.deleteConfirmation)
            assertEquals(1, repository.mutationCalls)

            gate.complete(Unit)
            advanceUntilIdle()
        } finally {
            experience.close()
        }
    }

    @Test
    fun `mutation builder preserves complete V2 fields and raw timed anchors`() {
        val recurrence = io.sentient.mobilesdk.calendar.StructuredRecurrence(
            frequency = io.sentient.mobilesdk.calendar.RecurrenceFrequency.WEEKLY,
            interval = 2,
            weekdays = listOf(io.sentient.mobilesdk.calendar.Weekday.MONDAY, io.sentient.mobilesdk.calendar.Weekday.WEDNESDAY),
            count = 6,
        )
        val draft = CalendarMutationDraft(
            title = "Timed event",
            description = "Details",
            allDay = false,
            start = "2026-08-10T09:00:00-04:00",
            end = "2026-08-10T10:00:00-04:00",
            scope = CalendarScope.HOUSEHOLD,
            visibility = Visibility.ADULTS,
            importance = Importance.PINNED,
            group = "family",
            tags = listOf("school", "family"),
            recurrence = recurrence,
            eventId = "event-1",
            occurrenceId = "event-1@2026-08-10T09:00:00-04:00",
            originalStart = "2026-08-10T09:00:00-04:00",
            expectedRevision = 7,
            inputTimeZoneId = "America/Toronto",
        )

        val create = assertIs<CalendarCommandBuildResult.Success<io.sentient.mobilesdk.calendar.CalendarCreateInput>>(
            buildCalendarCreateInput(draft.copy(eventId = null, occurrenceId = null, originalStart = null, expectedRevision = null)),
        ).value
        assertEquals("2026-08-10T09:00:00-04:00", create.start)
        assertEquals("2026-08-10T10:00:00-04:00", create.end)
        assertEquals(CalendarScope.HOUSEHOLD, create.scope)
        assertEquals(Visibility.ADULTS, create.visibility)
        assertEquals(Importance.PINNED, create.importance)
        assertEquals(recurrence, create.recurrence)

        for (scope in io.sentient.mobilesdk.calendar.CalendarMutationScope.entries) {
            val result = assertIs<CalendarCommandBuildResult.Success<CalendarMutationRequest.Update>>(
                buildCalendarUpdateRequest(draft, scope),
            ).value
            assertEquals("event-1", result.eventId)
            assertEquals(scope, result.command.applyTo)
            assertEquals(7, result.command.expectedRevision)
            assertEquals(CalendarScope.HOUSEHOLD, result.command.scope)
            assertEquals(
                if (scope == io.sentient.mobilesdk.calendar.CalendarMutationScope.ENTIRE_SERIES) null else draft.originalStart,
                result.command.originalStart,
            )
            assertEquals("2026-08-10T09:00:00-04:00", result.command.changes?.start)
            if (scope == io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_OCCURRENCE) {
                assertEquals(
                    io.sentient.mobilesdk.calendar.CalendarPatch.Unchanged,
                    result.command.changes?.recurrence,
                )
            }
        }

        val noSeconds = draft.copy(
            start = "2026-08-10T09:00-04:00",
            end = "2026-08-10T10:00-04:00",
            originalStart = "2026-08-10T09:00-04:00",
        )
        val noSecondsUpdate = assertIs<CalendarCommandBuildResult.Success<CalendarMutationRequest.Update>>(
            buildCalendarUpdateRequest(noSeconds, io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_OCCURRENCE),
        ).value
        assertEquals("2026-08-10T09:00-04:00", noSecondsUpdate.command.originalStart)
        assertEquals("2026-08-10T09:00-04:00", noSecondsUpdate.command.changes?.start)
        assertEquals(
            io.sentient.mobilesdk.calendar.CalendarPatch.Value("2026-08-10T10:00-04:00"),
            noSecondsUpdate.command.changes?.end,
        )

        for (scope in io.sentient.mobilesdk.calendar.CalendarMutationScope.entries) {
            val delete = assertIs<CalendarCommandBuildResult.Success<CalendarMutationRequest.Delete>>(
                buildCalendarDeleteRequest(draft, scope),
            ).value
            assertEquals(scope, delete.command.applyTo)
            assertEquals(7, delete.command.expectedRevision)
            assertEquals(
                if (scope == io.sentient.mobilesdk.calendar.CalendarMutationScope.ENTIRE_SERIES) null else draft.originalStart,
                delete.command.originalStart,
            )
        }
    }

    @Test
    fun `recurring delete requires explicit confirmation and scope`() = runTest {
        val window = monthWindow()
        val recurring = occurrence("recurring", title = "Series").copy(
            recurring = true,
            originalStart = "2026-06-14",
            recurrence = io.sentient.mobilesdk.calendar.StructuredRecurrence(
                frequency = io.sentient.mobilesdk.calendar.RecurrenceFrequency.DAILY,
                count = 3,
            ),
        )
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Success(
                CalendarMutationResult(
                    io.sentient.mobilesdk.calendar.CalendarOperation.DELETE,
                    io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_OCCURRENCE,
                    eventId = recurring.eventId,
                ),
            ),
        )
        val experience = experience(repository, FakeCacheStore(snapshot = snapshot(window)), window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            experience.editOccurrence(recurring)
            assertEquals(null, experience.state.value.mutation.mutationScope)
            experience.requestDelete()
            assertTrue(experience.state.value.mutation.isDeleteConfirmationOpen)
            experience.confirmDelete()
            assertEquals(CalendarMutationErrorKind.VALIDATION, experience.state.value.mutation.error?.kind)
            assertEquals(0, repository.mutationCalls)

            experience.confirmDelete(io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_OCCURRENCE)
            advanceUntilIdle()
            assertEquals(1, repository.mutationCalls)
            assertEquals(io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_OCCURRENCE, repository.lastCommand?.applyTo)
            assertEquals("2026-06-14", repository.lastCommand?.originalStart)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `conflict preserves draft and reread exposes authoritative event`() = runTest {
        val window = monthWindow()
        val current = occurrence("conflict", title = "Local")
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Failure(SentientError.Protocol("This calendar event changed. Refresh and try again.")),
            getResult = SentientResult.Success(event(id = "conflict", title = "Authoritative", revision = 9)),
        )
        val experience = experience(repository, FakeCacheStore(snapshot = snapshot(window)), window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            experience.editOccurrence(current)
            val draft = experience.state.value.mutation.draft!!.copy(title = "Local draft")
            experience.updateDraft(draft)
            experience.submitMutation()
            advanceUntilIdle()

            assertEquals(CalendarMutationErrorKind.CONFLICT, experience.state.value.mutation.error?.kind)
            assertEquals("Local draft", experience.state.value.mutation.draft?.title)
            assertTrue(experience.state.value.mutation.hasConflict)
            experience.rereadConflict()
            advanceUntilIdle()
            assertEquals("Authoritative", experience.state.value.mutation.conflict?.authoritativeEvent?.title)
            assertEquals("Local draft", experience.state.value.mutation.draft?.title)
            assertTrue(!experience.state.value.mutation.conflict!!.canSubmit)

            val callsBeforeBlindSubmit = repository.mutationCalls
            assertEquals(null, experience.submitMutation())
            assertEquals(callsBeforeBlindSubmit, repository.mutationCalls)
            assertTrue(!experience.state.value.mutation.conflict!!.canSubmit)

            assertTrue(experience.reviewConflict(experience.state.value.mutation.draft!!))
            assertEquals(9, experience.state.value.mutation.draft?.expectedRevision)
            assertTrue(experience.state.value.mutation.conflict!!.canSubmit)
            experience.submitMutation()
            advanceUntilIdle()
            assertEquals(callsBeforeBlindSubmit + 1, repository.mutationCalls)
            assertEquals(9, repository.lastCommand?.expectedRevision)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `typed permission and not-found failures retain the in-memory draft`() = runTest {
        val window = monthWindow()
        val forbiddenRepository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Failure(SentientError.Protocol("forbidden")),
        )
        val forbiddenExperience = experience(
            forbiddenRepository,
            FakeCacheStore(snapshot = snapshot(window)),
            window,
            this,
        )
        forbiddenExperience.observe(window)
        advanceUntilIdle()
        forbiddenExperience.editOccurrence(occurrence("permission", title = "keep permission draft"))
        forbiddenExperience.submitMutation()
        advanceUntilIdle()
        assertEquals(CalendarMutationErrorKind.FORBIDDEN, forbiddenExperience.state.value.mutation.error?.kind)
        assertEquals("keep permission draft", forbiddenExperience.state.value.mutation.draft?.title)
        forbiddenExperience.close()

        val notFoundRepository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Failure(SentientError.Protocol("not found")),
        )
        val notFoundExperience = experience(
            notFoundRepository,
            FakeCacheStore(snapshot = snapshot(window)),
            window,
            this,
        )
        try {
            notFoundExperience.observe(window)
            advanceUntilIdle()
            notFoundExperience.editOccurrence(occurrence("missing", title = "keep not-found draft"))
            notFoundExperience.submitMutation()
            advanceUntilIdle()
            assertEquals(CalendarMutationErrorKind.NOT_FOUND, notFoundExperience.state.value.mutation.error?.kind)
            assertEquals("keep not-found draft", notFoundExperience.state.value.mutation.draft?.title)
        } finally {
            notFoundExperience.close()
        }
    }

    @Test
    fun `offline save is rejected without calling repository or changing cached content`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val repository = FakeRepository(pages = listOf(page(event(title = "remote"))))
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            repository.offline = true
            experience.refresh()
            advanceUntilIdle()
            val callsBeforeMutation = repository.mutationCalls
            experience.createDraft(CalendarMutationDraft.create(start = "2026-06-20", allDay = true))
            experience.submitMutation()
            advanceUntilIdle()

            assertEquals(CalendarMutationErrorKind.CONNECTION, experience.state.value.mutation.error?.kind)
            assertEquals(callsBeforeMutation, repository.mutationCalls)
            assertEquals("remote", experience.state.value.projection?.visibleEvents?.single()?.title)
            assertTrue(experience.state.value.mutation.draft != null)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `create success exposes a typed outcome and refreshes through the shared path`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window))
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            createResult = SentientResult.Success(event(id = "created", title = "Created", revision = 2)),
        )
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            experience.createDraft(
                CalendarMutationDraft.create(
                    start = "2026-06-20",
                    title = "Created",
                    scope = CalendarScope.PRIVATE,
                ),
            )
            experience.submitMutation()
            advanceUntilIdle()

            assertEquals(1, repository.createCalls)
            assertIs<CalendarMutationOutcome.Success>(experience.state.value.mutation.outcome)
            assertEquals(null, experience.state.value.mutation.editor)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `successful mutation exposes successor and revalidates without clearing the editor source data`() = runTest {
        val window = monthWindow()
        val repository = FakeRepository(
            pages = listOf(page(event(title = "remote"))),
            mutationResult = SentientResult.Success(
                CalendarMutationResult(
                    io.sentient.mobilesdk.calendar.CalendarOperation.UPDATE,
                    io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_AND_FOLLOWING,
                    eventId = "event-successor",
                    successorEventId = "successor-event",
                    resultingRevision = 8,
                ),
            ),
        )
        val experience = experience(repository, FakeCacheStore(snapshot = snapshot(window)), window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            val source = occurrence("successor", title = "Before").copy(
                recurring = true,
                originalStart = "2026-06-14T09:00:00-04:00",
                start = "2026-06-14T09:00:00-04:00",
                end = "2026-06-14T10:00:00-04:00",
                recurrence = io.sentient.mobilesdk.calendar.StructuredRecurrence(
                    frequency = io.sentient.mobilesdk.calendar.RecurrenceFrequency.WEEKLY,
                    weekdays = listOf(io.sentient.mobilesdk.calendar.Weekday.MONDAY),
                    count = 4,
                ),
            )
            experience.editOccurrence(source)
            experience.chooseMutationScope(io.sentient.mobilesdk.calendar.CalendarMutationScope.THIS_AND_FOLLOWING)
            experience.updateDraft(experience.state.value.mutation.draft!!.copy(title = "After"))
            experience.submitMutation()
            advanceUntilIdle()

            assertEquals("successor-event", experience.state.value.mutation.successorEventId)
            assertIs<CalendarMutationOutcome.Success>(experience.state.value.mutation.outcome)
            assertTrue(repository.calls > 0)
            assertTrue(experience.state.value.authorizedOccurrences.isNotEmpty())
            assertEquals(null, experience.state.value.mutation.draft)
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
        private val swallowCancellation: Boolean = false,
        private val failureWindows: Set<Pair<String, String>> = emptySet(),
        private val authFailure: Boolean = false,
        private val forbiddenFailure: Boolean = false,
        private val beforeMutation: (suspend () -> Unit)? = null,
        private val swallowMutationCancellation: Boolean = false,
        private val createResult: SentientResult<CalendarEvent>? = null,
        private val mutationResult: SentientResult<CalendarMutationResult> = SentientResult.Success(
            CalendarMutationResult(
                io.sentient.mobilesdk.calendar.CalendarOperation.UPDATE,
                io.sentient.mobilesdk.calendar.CalendarMutationScope.ENTIRE_SERIES,
                eventId = "event",
            ),
        ),
        private val getResult: SentientResult<CalendarEvent> = SentientResult.Failure(SentientError.Unknown("unused")),
    ) : CalendarRepository {
        private val pageIndexes = mutableMapOf<Pair<String, String>, Int>()
        private val cancelledWindows = mutableSetOf<Pair<String, String>>()
        var calls: Int = 0
        var cancelled: Boolean = false
        var offline: Boolean = false
        var mutationCancelled: Boolean = false
        val scopes = mutableListOf<CalendarScope?>()
        val windows = mutableListOf<Pair<String, String>>()
        var mutationCalls: Int = 0
        var createCalls: Int = 0
        var lastCommand: CalendarMutationCommand? = null

        override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?) = getResult

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
            val key = from to to
            windows += key
            val pageIndex = if (cursor == null) {
                val firstPage = if (key in cancelledWindows) 1 else 0
                pageIndexes[key] = firstPage
                firstPage
            } else {
                pageIndexes[key] ?: 1
            }
            pageIndexes[key] = pageIndex + 1
            try {
                beforePage?.invoke()
            } catch (cancelled: CancellationException) {
                this.cancelled = true
                cancelledWindows += key
                if (!swallowCancellation) throw cancelled
            }
            if (authFailure) {
                return SentientResult.Failure(SentientError.Auth("expired", terminal = true))
            }
            if (forbiddenFailure) {
                return SentientResult.Failure(SentientError.Protocol("forbidden"))
            }
            if (offline || key in failureWindows) {
                return SentientResult.Failure(SentientError.Connection("offline"))
            }
            return pages.getOrElse(pageIndex) { pages.last() }
        }

        override suspend fun create(event: CalendarEvent) = error("unused")
        override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> {
            createCalls++
            return createResult ?: error("unused")
        }
        override suspend fun mutate(eventId: String, command: CalendarMutationCommand): SentientResult<CalendarMutationResult> {
            mutationCalls++
            lastCommand = command
            try {
                beforeMutation?.invoke()
            } catch (cancelled: CancellationException) {
                mutationCancelled = true
                if (!swallowMutationCancellation) throw cancelled
            }
            return mutationResult
        }
    }

    private class FakeCacheStore(
        snapshot: CalendarCacheSnapshot? = null,
        preferences: CalendarCachePreferences? = null,
    ) : CalendarCacheStore {
        private val namespaceState = MutableStateFlow(CalendarCacheNamespace("account", "backend"))
        override val currentNamespace = namespaceState.asStateFlow()
        override val isClosed: Boolean = false
        private val snapshotStates = mutableMapOf<CalendarCacheWindow, MutableStateFlow<CalendarCacheReadResult<CalendarCacheSnapshot?>>>()
        private val snapshots = mutableMapOf<CalendarCacheWindow, CalendarCacheSnapshot>()
        private val preferencesState = MutableStateFlow<CalendarCacheReadResult<CalendarCachePreferences?>>(CalendarCacheResult.Success(preferences))
        private var observedWindow: CalendarCacheWindow? = snapshot?.window
        var snapshot: CalendarCacheSnapshot? = snapshot
        var replacements: Int = 0
        val replacementNamespaces = mutableListOf<CalendarCacheNamespace>()
        val writtenPreferences = mutableListOf<CalendarCachePreferences>()

        init {
            snapshot?.let { snapshots[it.window] = it }
        }

        private fun snapshotState(window: CalendarCacheWindow): MutableStateFlow<CalendarCacheReadResult<CalendarCacheSnapshot?>> =
            snapshotStates.getOrPut(window) {
                MutableStateFlow(CalendarCacheResult.Success(snapshots[window]))
            }

        fun snapshotFor(window: CalendarCacheWindow): CalendarCacheSnapshot? = snapshots[window]

        override fun observeSnapshot(window: CalendarCacheWindow): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> {
            if (observedWindow == null) observedWindow = window
            return snapshotState(window)
        }
        override suspend fun readSnapshot(window: CalendarCacheWindow) = snapshotState(window).value
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
            replacementNamespaces += namespaceState.value
            val committed = CalendarCacheSnapshot(window, occurrences, fetchedAt, lastAccessedAt, freshness)
            snapshots[window] = committed
            if (observedWindow == null) observedWindow = window
            if (observedWindow == window) snapshot = committed
            snapshotState(window).value = CalendarCacheResult.Success(committed)
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
        override suspend fun purgeNamespace(namespace: CalendarCacheNamespace): CalendarCacheResult<Unit> {
            snapshots.clear()
            snapshot = null
            snapshotStates.values.forEach { it.value = CalendarCacheResult.Success(null) }
            return CalendarCacheResult.Success(Unit)
        }
        override suspend fun switchNamespace(namespace: CalendarCacheNamespace, purgePrevious: Boolean): CalendarCacheResult<Unit> {
            namespaceState.value = namespace
            // This fake owns one active query stream; switching it must not
            // replay the predecessor's rows or preferences as successor data.
            snapshots.clear()
            snapshot = null
            snapshotStates.values.forEach { it.value = CalendarCacheResult.Success(null) }
            preferencesState.value = CalendarCacheResult.Success(null)
            return CalendarCacheResult.Success(Unit)
        }
        override fun close() = Unit
    }
}
