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
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertSame
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
    fun `window-changing navigation clears old authorized content before observation`() = runTest {
        val window = monthWindow()
        val gate = CompletableDeferred<Unit>()
        val experience = experience(
            repository = FakeRepository(
                pages = listOf(page(event(title = "remote"))),
                beforePage = { gate.await() },
            ),
            cache = FakeCacheStore(snapshot = snapshot(window, title = "old-window")),
            window = window,
            scope = this,
        )
        try {
            experience.observe(window)
            runCurrent()
            assertEquals("old-window", experience.state.value.authorizedOccurrences.single().title)

            experience.next()

            val changed = experience.state.value
            assertEquals("2026-07-14", changed.anchorDate)
            assertTrue(changed.authorizedOccurrences.isEmpty())
            assertTrue(changed.projection?.visibleEvents.isNullOrEmpty())
            assertEquals(CalendarLoadingPhase.LOADING, changed.loading.phase)
            assertTrue(!changed.hasCompleteCache)
            assertEquals(null, changed.cachedWindow)
        } finally {
            gate.complete(Unit)
            experience.close()
        }
    }

    @Test
    fun `year observation does not schedule adjacent month prefetch`() = runTest {
        val window = monthWindow()
        val repository = FakeRepository(pages = listOf(page(event(title = "remote"))))
        val experience = experience(repository, FakeCacheStore(snapshot = snapshot(window)), window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            val callsBeforeYear = repository.windows.size

            experience.selectView(CalendarView.YEAR)
            advanceUntilIdle()

            assertEquals(
                listOf("2026-01-01" to "2027-01-01"),
                repository.windows.drop(callsBeforeYear),
            )
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
    fun `cached content survives offline and duplicate recovery signals coalesce to one refresh`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val repository = FakeRepository(pages = listOf(page(event(title = "refreshed")))).apply {
            offline = true
        }
        val experience = experience(repository, cache, window, this)
        try {
            experience.observe(window)
            advanceUntilIdle()
            assertEquals("cached", experience.state.value.authorizedOccurrences.single().title)
            assertEquals(CalendarFreshness.CACHED_OFFLINE, experience.state.value.freshness)
            val callsBeforeRecovery = repository.windows.count { it == (window.windowStart to window.windowEnd) }

            repository.offline = false
            experience.onConnectivityRecovered()
            experience.onConnectivityRecovered()
            advanceUntilIdle()

            assertEquals(
                callsBeforeRecovery + 1,
                repository.windows.count { it == (window.windowStart to window.windowEnd) },
            )
            assertEquals("refreshed", experience.state.value.authorizedOccurrences.single().title)
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
        } finally {
            experience.close()
        }
    }

    @Test
    fun `one recovery edge republishes current and adjacent sentinels without blanking`() = runTest {
        val window = monthWindow()
        val previous = CalendarCacheWindow("2026-05-01", "2026-06-01")
        val next = CalendarCacheWindow("2026-07-01", "2026-08-01")
        val cache = FakeCacheStore()
        val repository = FakeRepository(pages = listOf(page(event(title = "prime-sentinel"))))
        val experience = experience(repository, cache, window, this)
        val visibleCounts = mutableListOf<Int>()
        val collector = launch { experience.state.collect { visibleCounts += it.authorizedOccurrences.size } }
        try {
            experience.observe(window)
            advanceUntilIdle()
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals("prime-sentinel", cache.snapshotFor(previous)?.occurrences?.single()?.title)
            assertEquals("prime-sentinel", cache.snapshotFor(next)?.occurrences?.single()?.title)

            repository.offline = true
            experience.refresh()
            advanceUntilIdle()
            assertEquals(CalendarFreshness.CACHED_OFFLINE, experience.state.value.freshness)
            val callsBeforeRecovery = repository.windows.groupingBy { it }.eachCount()
            repository.pagesOverride = listOf(page(event(title = "recovery-sentinel")))
            repository.offline = false

            experience.onConnectivityRecovered()
            advanceUntilIdle()

            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(CalendarRecoveryPhase.UP_TO_DATE, experience.state.value.recovery.phase)
            assertTrue(experience.state.value.recoveryReady)
            assertEquals("recovery-sentinel", experience.state.value.authorizedOccurrences.single().title)
            assertEquals("recovery-sentinel", cache.snapshotFor(previous)?.occurrences?.single()?.title)
            assertEquals("recovery-sentinel", cache.snapshotFor(next)?.occurrences?.single()?.title)
            val callsAfterRecovery = repository.windows.groupingBy { it }.eachCount()
            for (target in listOf(window, previous, next)) {
                val key = target.windowStart to target.windowEnd
                assertEquals((callsBeforeRecovery[key] ?: 0) + 1, callsAfterRecovery[key])
            }
            val firstContent = visibleCounts.indexOfFirst { it > 0 }
            assertTrue(firstContent >= 0 && visibleCounts.drop(firstContent).all { it > 0 })
        } finally {
            collector.cancel()
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
        val otherWindow = CalendarCacheWindow("2026-09-01", "2026-10-01")
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

            // Move outside adjacent prefetch range so no successor consumer
            // retains the original key. Releasing its final waiter must cancel
            // the transport before returning to the same key.
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
            // Purge is an all-consumer invalidation, unlike navigation which
            // may retain a transport for another viewport/prefetch waiter.
            experience.purgeNamespace()
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
    fun `reconnect while refreshing supersedes old request and publishes one usable sentinel`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached-sentinel"))
        val repository = RecoveryRaceRepository()
        val experience = experience(repository, cache, window, this)
        val visibleCounts = mutableListOf<Int>()
        val collector = launch { experience.state.collect { visibleCounts += it.authorizedOccurrences.size } }
        try {
            experience.observe(window)
            advanceUntilIdle()
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(CalendarLoadingPhase.IDLE, experience.state.value.loading.phase)
            assertEquals("prime-sentinel", experience.state.value.authorizedOccurrences.single().title)

            repository.armStaleRequest = true
            experience.refresh()
            runCurrent()
            repository.staleEntered.await()
            assertEquals(CalendarFreshness.REFRESHING, experience.state.value.freshness)

            val callsBeforeRecovery = repository.currentWindowCalls
            val firstRecovery = experience.onConnectivityRecovered()
            val duplicateRecovery = experience.onConnectivityRecovered()
            assertSame(firstRecovery, duplicateRecovery)
            advanceUntilIdle()

            assertTrue(repository.staleCancelled)
            assertEquals(callsBeforeRecovery + 1, repository.currentWindowCalls)
            assertEquals(CalendarFreshness.FRESH, experience.state.value.freshness)
            assertEquals(CalendarLoadingPhase.IDLE, experience.state.value.loading.phase)
            assertEquals(CalendarRecoveryPhase.UP_TO_DATE, experience.state.value.recovery.phase)
            assertEquals("recovery-sentinel", experience.state.value.authorizedOccurrences.single().title)
            assertEquals("recovery-sentinel", cache.snapshotFor(window)?.occurrences?.single()?.title)
            assertTrue(cache.replacementTitles.drop(3).none { it == "old-stale-sentinel" })
            val firstVisible = visibleCounts.indexOfFirst { it > 0 }
            assertTrue(firstVisible >= 0 && visibleCounts.drop(firstVisible).all { it > 0 })
        } finally {
            collector.cancel()
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
            assertTrue(experience.state.value.presentationReady)
            assertTrue(repository.scopes.all { it == CalendarScope.ALL })
        } finally {
            experience.close()
        }
    }

    @Test
    fun `process recreation restores Month date and filters before presentation readiness`() = runTest {
        val window = monthWindow()
        val cache = FakeCacheStore(snapshot = snapshot(window, title = "cached"))
        val repository = FakeRepository(pages = listOf(page(event(group = "family"))))
        val first = experience(repository, cache, window, this)
        try {
            first.observe(window)
            advanceUntilIdle()
            first.selectDate("2026-06-19")
            first.selectView(CalendarView.MONTH)
            first.setFilters(CalendarFilters(scope = CalendarScope.HOUSEHOLD, groups = setOf("family")))
            advanceUntilIdle()
        } finally {
            first.close()
        }

        val recreated = experience(repository, cache, window, this)
        try {
            assertTrue(!recreated.state.value.presentationReady)
            recreated.observe(window)
            advanceUntilIdle()

            val restored = recreated.state.value
            assertTrue(restored.presentationReady)
            assertEquals(CalendarView.MONTH, restored.view)
            assertEquals("2026-06-19", restored.anchorDate)
            assertEquals("2026-06-19", restored.selectedDate)
            assertEquals(CalendarScope.HOUSEHOLD, restored.filters.scope)
            assertEquals(setOf("family"), restored.filters.groups)
        } finally {
            recreated.close()
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
            val viewportPeriod = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(viewportPeriod))
            advanceUntilIdle()
            repository.pagesOverride = listOf(page(event(title = "after mutation", revision = 8)))
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

            assertEquals(8, lease.state.value.periods[viewportPeriod]?.projection?.visibleEvents?.single()?.revision)
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

    @Test
    fun `explicit viewport navigation reduces from browsed cursor with one coherent semantic result`() = runTest {
        val cursor = "2032-02-29"
        val cases: List<Triple<CalendarView, CalendarNavigationAction, String>> = listOf(
            Triple(CalendarView.MONTH, CalendarNavigationAction.Previous, "2032-01-29"),
            Triple(CalendarView.MONTH, CalendarNavigationAction.Next, "2032-03-29"),
            Triple(CalendarView.YEAR, CalendarNavigationAction.Previous, "2031-02-28"),
            Triple(CalendarView.YEAR, CalendarNavigationAction.Next, "2033-02-28"),
            Triple(CalendarView.YEAR, CalendarNavigationAction.SelectView(CalendarView.MONTH), cursor),
        ) + CalendarView.entries.map { target ->
            Triple(CalendarView.MONTH, CalendarNavigationAction.SelectView(target), cursor)
        }
        for ((initialView, action, expectedDate) in cases) {
            val cache = FakeCacheStore()
            val repository = FakeRepository(listOf(page()), beforePage = { CompletableDeferred<Unit>().await() })
            val experience = experience(repository, cache, monthWindow(), this)
            val published = mutableListOf<Triple<CalendarView, String, String>>()
            try {
                experience.selectView(initialView)
                runCurrent()
                cache.writtenPreferences.clear()
                val collector = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
                    experience.state.collect { published += Triple(it.view, it.anchorDate, it.selectedDate) }
                }
                published.clear()
                val expectedView = (action as? CalendarNavigationAction.SelectView)?.view ?: initialView
                assertEquals(CalendarViewportRequestResult.ACCEPTED, experience.navigateFromViewport(cursor, action))
                runCurrent()
                // Unconfined collection sees intermediate publications too:
                // neither a cursor-only state nor an intermediate view may leak.
                assertEquals(listOf(Triple(expectedView, expectedDate, expectedDate)), published.distinct())
                val preferences = cache.writtenPreferences.single()
                assertEquals(expectedDate, preferences.anchorDate)
                assertEquals(expectedView, preferences.view)
                val cacheView = if (expectedView == CalendarView.YEAR) CalendarView.YEAR else CalendarView.MONTH
                val interval = calendarVisibleInterval(cacheView, expectedDate, experience.state.value.locale)
                assertEquals(CalendarCacheWindow(interval.startDate, interval.endExclusive, experience.state.value.locale.timeZoneId), experience.visibleWindow)
                collector.cancel()
            } finally { experience.close() }
        }
    }

    @Test
    fun `Week viewport date tap retains distant anchor and publishes only the selected date result`() = runTest {
        for (language in listOf("en-US", "en-GB")) {
            val cache = FakeCacheStore()
            val subject = experience(FakeRepository(listOf(page()), beforePage = { CompletableDeferred<Unit>().await() }),
                cache, monthWindow(), this)
            try {
                subject.setLocale(CalendarLocale(languageTag = language))
                subject.selectView(CalendarView.WEEK)
                runCurrent()
                cache.writtenPreferences.clear()
                val cursor = "2032-02-29"
                val interval = calendarVisibleInterval(CalendarView.WEEK, cursor, subject.state.value.locale)
                val selected = if (interval.startDate != cursor) interval.startDate else addCalendarDays(cursor, 1)
                val published = mutableListOf<Triple<CalendarView, String, String>>()
                val collector = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
                    subject.state.collect { published += Triple(it.view, it.anchorDate, it.selectedDate) }
                }
                published.clear()
                assertEquals(CalendarViewportRequestResult.ACCEPTED,
                    subject.navigateFromViewport(cursor, CalendarNavigationAction.SelectDate(selected)))
                runCurrent()
                assertEquals(listOf(Triple(CalendarView.WEEK, cursor, selected)), published.distinct())
                assertEquals(cursor, cache.writtenPreferences.single().anchorDate)
                assertEquals(CalendarView.WEEK, cache.writtenPreferences.single().view)
                assertEquals(viewportWindow(cursor, subject.state.value.locale), subject.visibleWindow)
                // Snapshot emissions combine with the same anchor-only preference
                // record; they must not replay it as a fresh selection intent.
                cache.replaceSnapshot(snapshot(subject.visibleWindow, occurrences = emptyList()))
                runCurrent()
                assertEquals(listOf(Triple(CalendarView.WEEK, cursor, selected)), published.distinct())
                collector.cancel()
                cache.writtenPreferences.clear()
                val before = subject.state.value
                val window = subject.visibleWindow
                for (date in listOf(addCalendarDays(interval.startDate, -1), interval.endExclusive)) {
                    assertEquals(CalendarViewportRequestResult.OUTSIDE_VISIBLE_WEEK,
                        subject.navigateFromViewport(cursor, CalendarNavigationAction.SelectDate(date)))
                }
                for ((anchor, date) in listOf(cursor to "2032-02-30", "9999-12-31" to "9999-12-31")) {
                    assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                        subject.navigateFromViewport(anchor, CalendarNavigationAction.SelectDate(date)))
                }
                runCurrent()
                assertEquals(before, subject.state.value)
                assertEquals(window, subject.visibleWindow)
                assertTrue(cache.writtenPreferences.isEmpty())
                for (view in listOf(CalendarView.DAY, CalendarView.MONTH, CalendarView.YEAR)) {
                    subject.selectView(view)
                    runCurrent()
                    cache.writtenPreferences.clear()
                    val nonWeek = subject.state.value
                    assertEquals(CalendarViewportRequestResult.UNSUPPORTED_ACTION,
                        subject.navigateFromViewport(cursor, CalendarNavigationAction.SelectDate(selected)))
                    runCurrent()
                    assertEquals(nonWeek, subject.state.value)
                    assertTrue(cache.writtenPreferences.isEmpty())
                }
                subject.close()
                assertEquals(CalendarViewportRequestResult.RETIRED,
                    subject.navigateFromViewport(cursor, CalendarNavigationAction.SelectDate(selected)))
            } finally { subject.close() }
        }
    }

    @Test
    fun `Week selection survives preference echoes but changed external preferences and recreation restore anchor`() = runTest {
        val cache = FakeCacheStore()
        val repository = FakeRepository(listOf(page())).also { it.offline = true }
        val subject = experience(repository, cache, monthWindow(), this)
        val anchor = "2032-02-29"
        val selected = "2032-03-01"
        try {
            subject.selectView(CalendarView.WEEK)
            advanceUntilIdle()
            assertEquals(CalendarViewportRequestResult.ACCEPTED,
                subject.navigateFromViewport(anchor, CalendarNavigationAction.SelectDate(selected)))
            advanceUntilIdle()
            assertEquals(selected, subject.state.value.selectedDate)
            val ownPreferences = cache.writtenPreferences.last()
            // A timestamp-only notification carries no new presentation intent.
            cache.writePreferences(ownPreferences.copy(updatedAt = 200L))
            runCurrent()
            assertEquals(selected, subject.state.value.selectedDate)
            // A genuine external filter change still restores even at the same anchor.
            cache.writePreferences(ownPreferences.copy(searchText = "external", updatedAt = 201L))
            runCurrent()
            assertEquals("external", subject.state.value.filters.text)
            assertEquals(anchor, subject.state.value.selectedDate)
            // Ordinary Week SelectDate uses the same echo-safe live selection.
            subject.selectDate(selected)
            runCurrent()
            assertEquals(anchor, subject.state.value.anchorDate)
            assertEquals(selected, subject.state.value.selectedDate)
            cache.writePreferences(ownPreferences.copy(view = CalendarView.DAY, anchorDate = "2032-03-02", updatedAt = 202L))
            runCurrent()
            assertEquals(CalendarView.DAY, subject.state.value.view)
            assertEquals("2032-03-02", subject.state.value.anchorDate)
            assertEquals("2032-03-02", subject.state.value.selectedDate)
            subject.selectView(CalendarView.WEEK)
            runCurrent()
            subject.selectDate("2032-03-03")
            runCurrent()
            assertEquals("2032-03-03", subject.state.value.selectedDate)
        } finally { subject.close() }
        val recreated = experience(repository, cache, monthWindow(), this)
        try {
            recreated.observe()
            advanceUntilIdle()
            assertEquals(CalendarView.WEEK, recreated.state.value.view)
            assertEquals("2032-03-02", recreated.state.value.anchorDate)
            assertEquals("2032-03-02", recreated.state.value.selectedDate)
        } finally { recreated.close() }
    }

    @Test
    fun `adjacent lease resolves exact current visible identity and rejects queued context and retired membership`() = runTest {
        val day = CalendarViewportPeriod(CalendarView.DAY, "2026-06-14")
        val week = CalendarViewportPeriod(CalendarView.WEEK, "2026-06-14")
        val window = viewportWindow(day.anchorDate)
        val original = occurrence("adjacent", "original")
        val changedStart = original.copy(originalStart = "2026-06-13", title = "other original start")
        val changedScope = original.copy(scope = CalendarScope.PRIVATE, title = "other scope")
        val cache = FakeCacheStore(snapshot(window, occurrences = listOf(original, changedStart, changedScope)))
        val subject = experience(FakeRepository(listOf(page())).also { it.offline = true }, cache, monthWindow(), this)
        try {
            val lease = subject.acquireViewport()
            assertTrue(lease.isActive)
            assertTrue(lease.state.value.periods.isEmpty())
            lease.setPeriods(listOf(day, week))
            assertEquals(null, lease.resolveOccurrence(original.identity())) // not published yet
            advanceUntilIdle()
            for (record in listOf(original, changedStart, changedScope)) {
                assertEquals(record, lease.resolveOccurrence(record.identity()))
            }
            assertEquals(null, lease.resolveOccurrence(original.identity().copy(occurrenceId = "missing")))
            assertEquals(null, lease.resolveOccurrence(original.identity().copy(eventId = "missing")))
            assertEquals(null, lease.resolveOccurrence(original.identity().copy(originalStart = "2026-06-12")))
            assertEquals(null, lease.resolveOccurrence(original.identity().copy(scope = CalendarScope.ALL)))
            val latest = original.copy(revision = 12, title = "latest")
            cache.replaceSnapshot(CalendarCacheSnapshot(window, listOf(latest, changedStart, changedScope), 200L))
            runCurrent()
            assertEquals(latest, lease.resolveOccurrence(original.identity()))
            subject.setFilters(CalendarFilters(text = "other scope"))
            assertTrue(lease.isActive)
            // Presentation collector has not run: old Prepared rows still exist.
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            assertEquals(null, lease.resolveOccurrence(changedScope.identity()))
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            assertEquals(changedScope, lease.resolveOccurrence(changedScope.identity()))
            subject.setFilters(CalendarFilters())
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            runCurrent()
            assertEquals(latest, lease.resolveOccurrence(original.identity()))
            subject.setLocale(CalendarLocale(timeZoneId = "America/New_York"))
            assertTrue(lease.isActive)
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            subject.setLocale(CalendarLocale())
            runCurrent()
            assertEquals(latest, lease.resolveOccurrence(original.identity()))
            lease.setPeriods(listOf(CalendarViewportPeriod(CalendarView.DAY, "2026-06-20")))
            assertEquals(null, lease.resolveOccurrence(original.identity())) // same window, no visible membership
            lease.setPeriods(listOf(CalendarViewportPeriod(CalendarView.WEEK, "2026-06-21")))
            assertEquals(null, lease.resolveOccurrence(original.identity())) // same month, outside this visible week
            lease.setPeriods(emptyList())
            assertTrue(lease.isActive)
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            lease.setPeriods(listOf(day))
            runCurrent()
            assertEquals(latest, lease.resolveOccurrence(original.identity()))
            val successor = subject.acquireViewport()
            assertFalse(lease.isActive)
            assertTrue(successor.isActive)
            successor.setPeriods(listOf(day))
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(original.identity()))
            lease.close()
            assertTrue(successor.isActive)
            assertEquals(latest, successor.resolveOccurrence(original.identity()))
            successor.close()
            assertFalse(successor.isActive)
            assertEquals(null, successor.resolveOccurrence(original.identity()))
        } finally { subject.close() }
    }

    @Test
    fun `invalid unsupported and retired viewport navigation leaves semantic state and preferences unchanged`() = runTest {
        val cache = FakeCacheStore()
        val subject = experience(FakeRepository(listOf(page())), cache, monthWindow(), this)
        try {
            val before = subject.state.value
            val window = subject.visibleWindow
            assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                subject.navigateFromViewport("2032-02-30", CalendarNavigationAction.Next))
            assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                subject.navigateFromViewport("9999-12-01", CalendarNavigationAction.Next))
            assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                subject.navigateFromViewport("9999-01-01", CalendarNavigationAction.SelectView(CalendarView.YEAR)))
            val unsupported = listOf(
                CalendarNavigationAction.Today,
                CalendarNavigationAction.SelectDate("2032-02-29"),
                CalendarNavigationAction.SelectMonth(2032, 2),
                CalendarNavigationAction.SetFilters(CalendarFilters()),
                CalendarNavigationAction.SetLocale(CalendarLocale()),
            )
            unsupported.forEach {
                assertEquals(CalendarViewportRequestResult.UNSUPPORTED_ACTION, subject.navigateFromViewport("2032-02-29", it))
            }
            runCurrent()
            assertEquals(before, subject.state.value)
            assertEquals(window, subject.visibleWindow)
            assertTrue(cache.writtenPreferences.isEmpty())
            subject.close()
            val closed = subject.state.value
            assertEquals(CalendarViewportRequestResult.RETIRED,
                subject.navigateFromViewport("2032-02-29", CalendarNavigationAction.Next))
            assertEquals(closed, subject.state.value)
            assertTrue(cache.writtenPreferences.isEmpty())
        } finally { subject.close() }

        val forbiddenCache = FakeCacheStore()
        val forbidden = experience(FakeRepository(listOf(page()), forbiddenFailure = true), forbiddenCache, monthWindow(), this)
        try {
            forbidden.observe()
            advanceUntilIdle()
            val denied = forbidden.state.value
            assertEquals(CalendarExperienceErrorKind.FORBIDDEN, denied.error?.kind)
            assertEquals(CalendarViewportRequestResult.RETIRED,
                forbidden.navigateFromViewport("2032-02-29", CalendarNavigationAction.SelectView(CalendarView.YEAR)))
            assertEquals(denied, forbidden.state.value)
            assertTrue(forbiddenCache.writtenPreferences.isEmpty())
        } finally { forbidden.close() }
    }

    @Test
    fun `viewport projects simultaneous cached periods without semantic navigation and follows filters and locale`() = runTest {
        val june = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
        val july = CalendarViewportPeriod(CalendarView.MONTH, "2026-07-01")
        val cache = FakeCacheStore(snapshot(viewportWindow(june.anchorDate)))
        cache.replaceSnapshot(snapshot(viewportWindow(july.anchorDate), occurrences = emptyList()))
        val repository = FakeRepository(listOf(page()), beforePage = { CompletableDeferred<Unit>().await() })
        val experience = experience(repository, cache, monthWindow(), this)
        try {
            val semantic = experience.state.value
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(june, july))
            runCurrent()
            assertEquals(semantic, experience.state.value)
            assertEquals(monthWindow(), experience.visibleWindow)
            assertTrue(cache.writtenPreferences.isEmpty())
            assertNotNull(lease.state.value.periods[june]?.projection)
            assertTrue(assertNotNull(lease.state.value.periods[july]?.projection).visibleEvents.isEmpty())
            val calls = repository.calls
            experience.setFilters(CalendarFilters(groups = setOf("missing")))
            runCurrent()
            lease.state.value.periods.values.forEach {
                assertTrue(assertNotNull(it.projection).visibleEvents.isEmpty())
                assertTrue("missing" in it.projection!!.facets.groups)
            }
            assertEquals(calls, repository.calls)
            val locale = CalendarLocale(languageTag = "en-GB", timeZoneId = "America/New_York")
            experience.setLocale(locale)
            runCurrent()
            assertEquals(viewportWindow(june.anchorDate, locale), lease.state.value.periods[june]?.window)
            assertEquals(null, lease.state.value.periods[june]?.projection)
            assertEquals(semantic.selectedDate, experience.state.value.selectedDate)
        } finally { experience.close() }
    }

    @Test
    fun `viewport latest request bounds transport and obsolete lease cannot clear successor`() = runTest {
        val repository = FakeRepository(listOf(page()), beforePage = { CompletableDeferred<Unit>().await() })
        val experience = experience(repository, FakeCacheStore(), monthWindow(), this)
        try {
            val old = experience.acquireViewport()
            val requested = (0 until old.maximumPeriods).map {
                CalendarViewportPeriod(CalendarView.MONTH, addCalendarMonthsClamped("2026-01-01", it))
            }
            old.setPeriods(requested)
            runCurrent()
            assertEquals(2, repository.calls)
            assertEquals(requested.size, old.state.value.periods.size)
            val accepted = old.state.value
            assertEquals(CalendarViewportRequestResult.TOO_MANY_PERIODS, old.setPeriods(requested + requested.first()))
            assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                old.setPeriods(listOf(CalendarViewportPeriod(CalendarView.MONTH, "2026-02-30"))))
            assertEquals(CalendarViewportRequestResult.INVALID_DATE,
                old.setPeriods(listOf(CalendarViewportPeriod(CalendarView.MONTH, "9999-12-01"))))
            assertEquals(CalendarViewportRequestResult.UNSUPPORTED_VIEW,
                old.setPeriods(listOf(CalendarViewportPeriod(CalendarView.YEAR, "2026-01-01"))))
            assertEquals(accepted, old.state.value)
            val latest = CalendarViewportPeriod(CalendarView.MONTH, "2035-01-01")
            old.setPeriods(listOf(latest))
            runCurrent()
            assertTrue(repository.cancelled)
            assertEquals(3, repository.calls)
            assertEquals(setOf(latest), experience.viewportState.value.periods.keys)
            val successor = experience.acquireViewport()
            successor.setPeriods(listOf(CalendarViewportPeriod(CalendarView.DAY, "2035-01-02")))
            old.close()
            assertEquals(CalendarViewportRequestResult.RETIRED, old.setPeriods(requested))
            runCurrent()
            assertEquals(CalendarView.DAY, experience.viewportState.value.periods.keys.single().view)
            successor.close()
            assertTrue(experience.viewportState.value.periods.isEmpty())
        } finally { experience.close() }
    }

    @Test
    fun `releasing viewport does not cancel a coalesced foreground load`() = runTest {
        val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
        val window = viewportWindow(period.anchorDate)
        val gate = CompletableDeferred<Unit>()
        val repository = FakeRepository(listOf(page(event(title = "fresh"))), beforePage = { gate.await() })
        val experience = experience(repository, FakeCacheStore(snapshot(window)), window, this)
        try {
            experience.observe(window)
            runCurrent()
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(period))
            runCurrent()
            assertEquals(1, repository.windows.count { it == (window.windowStart to window.windowEnd) })
            lease.close()
            runCurrent()
            assertTrue(!repository.cancelled)
            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("fresh", experience.state.value.projection?.visibleEvents?.single()?.title)
        } finally { experience.close() }
    }

    @Test
    fun `foreground replacement preserves a coalesced load still requested by viewport`() = runTest {
        for (navigate in listOf(false, true)) {
            val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
            val window = viewportWindow(period.anchorDate)
            val key = window.windowStart to window.windowEnd
            val gate = CompletableDeferred<Unit>()
            val repository = FakeRepository(listOf(page(event(title = "completed original"))), beforePage = { gate.await() })
            val experience = experience(repository, FakeCacheStore(snapshot(window)), window, this)
            try {
                experience.observe(window)
                runCurrent()
                val lease = experience.acquireViewport()
                assertEquals(CalendarViewportRequestResult.ACCEPTED, lease.setPeriods(listOf(period)))
                runCurrent()
                assertTrue(lease.isActive)
                if (navigate) experience.next() else experience.observe(viewportWindow("2026-07-01"))
                assertTrue(lease.isActive)
                runCurrent()
                assertTrue(lease.isActive)
                assertTrue(key !in repository.cancelledWindows)
                assertEquals(1, repository.windows.count { it == key })
                gate.complete(Unit)
                advanceUntilIdle()
                assertEquals("completed original", lease.state.value.periods[period]?.projection?.visibleEvents?.single()?.title)
                assertEquals(1, repository.windows.count { it == key })
            } finally { experience.close() }
        }
    }

    @Test
    fun `overlapping viewport snapshots reconcile revisions and field recency in both arrival orders without adding membership`() = runTest {
        for (tie in listOf("revision", "fetch", "window")) {
            val equalRevision = tie != "revision"
            for (newerFirst in listOf(false, true)) {
                val june = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
                val july = CalendarViewportPeriod(CalendarView.MONTH, "2026-07-01")
                val juneWindow = viewportWindow(june.anchorDate)
                val julyWindow = viewportWindow(july.anchorDate)
                val older = occurrence("overlap", "older", group = "old group").copy(
                    start = "2026-06-30", end = "2026-07-01", originalStart = "2026-06-30",
                    revision = if (equalRevision) 10 else 9,
                )
                val newer = older.copy(revision = 10, title = "newer", group = "new group")
                val low = CalendarCacheSnapshot(juneWindow, listOf(older), if (tie == "window") 200L else if (equalRevision) 100L else 300L)
                val high = CalendarCacheSnapshot(julyWindow, listOf(newer), 200L)
                val cache = FakeCacheStore()
                val repository = FakeRepository(listOf(page())).also { it.offline = true }
                val experience = experience(repository, cache, monthWindow(), this)
                try {
                    val lease = experience.acquireViewport()
                    lease.setPeriods(listOf(june, july))
                    advanceUntilIdle()
                    cache.replaceSnapshot(if (newerFirst) high else low)
                    runCurrent()
                    val unknown = if (newerFirst) june else july
                    assertEquals(null, lease.state.value.periods[unknown]?.projection)
                    cache.replaceSnapshot(if (newerFirst) low else high)
                    runCurrent()
                    for (period in listOf(june, july)) {
                        val projection = assertNotNull(lease.state.value.periods[period]?.projection)
                        assertEquals(10, projection.visibleEvents.single().revision)
                        assertEquals("newer", projection.visibleEvents.single().title)
                        assertEquals(listOf("new group"), projection.facets.groups)
                    }
                    assertEquals(newer, lease.resolveOccurrence(older.identity()))
                    // July's own snapshot stays unchanged; its memo must still
                    // invalidate when the winning record changes in June.
                    cache.replaceSnapshot(CalendarCacheSnapshot(juneWindow,
                        listOf(newer.copy(revision = 11, title = "updated elsewhere")), 500L))
                    runCurrent()
                    assertEquals("updated elsewhere", lease.state.value.periods[july]?.projection?.visibleEvents?.single()?.title)
                    cache.replaceSnapshot(CalendarCacheSnapshot(julyWindow, emptyList(), 600L))
                    runCurrent()
                    val empty = assertNotNull(lease.state.value.periods[july]?.projection)
                    assertTrue(empty.authorizedOccurrences.isEmpty())
                    assertTrue(empty.facets.groups.isEmpty())
                    assertEquals(11, lease.state.value.periods[june]?.projection?.visibleEvents?.single()?.revision)
                    assertEquals(11, lease.resolveOccurrence(older.identity())?.revision)
                    lease.setPeriods(listOf(july))
                    assertEquals(null, lease.resolveOccurrence(older.identity()))
                } finally { experience.close() }
            }
        }
    }

    @Test
    fun `invalid cached viewport temporal data reports contract error and later cache update recovers`() = runTest {
        val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
        val window = viewportWindow(period.anchorDate)
        val cache = FakeCacheStore(snapshot(window, occurrences = listOf(occurrence("invalid", "invalid").copy(start = "not-a-time"))))
        val repository = FakeRepository(listOf(page())).also { it.offline = true }
        val experience = experience(repository, cache, monthWindow(), this)
        try {
            val lease = experience.acquireViewport()
            assertEquals(CalendarViewportRequestResult.ACCEPTED, lease.setPeriods(listOf(period)))
            advanceUntilIdle()
            assertEquals(CalendarExperienceErrorKind.CONTRACT, lease.state.value.periods[period]?.error?.kind)
            assertEquals(null, lease.resolveOccurrence(occurrence("invalid", "invalid").identity()))
            assertEquals(null, lease.state.value.periods[period]?.projection)
            cache.replaceSnapshot(CalendarCacheSnapshot(window, listOf(occurrence("valid", "valid")), 2L))
            runCurrent()
            assertEquals(null, lease.state.value.periods[period]?.error)
            assertEquals("valid", lease.state.value.periods[period]?.projection?.visibleEvents?.single()?.title)
            experience.setFilters(CalendarFilters(groups = setOf("absent")))
            runCurrent()
            assertTrue(assertNotNull(lease.state.value.periods[period]?.projection).visibleEvents.isEmpty())
        } finally { experience.close() }
    }

    @Test
    fun `viewport cache revisions reproject and unknown offline neighbor is not empty`() = runTest {
        val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
        val neighbor = CalendarViewportPeriod(CalendarView.MONTH, "2026-08-01")
        val window = viewportWindow(period.anchorDate)
        val cache = FakeCacheStore(snapshot(window))
        val repository = FakeRepository(listOf(page())).also { it.offline = true }
        val experience = experience(repository, cache, monthWindow(), this)
        try {
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(period, neighbor))
            advanceUntilIdle()
            assertEquals(CalendarFreshness.CACHED_OFFLINE, lease.state.value.periods[period]?.freshness)
            assertNotNull(lease.state.value.periods[period]?.projection)
            assertEquals(null, lease.state.value.periods[neighbor]?.projection)
            assertEquals(CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE, lease.state.value.periods[neighbor]?.error?.kind)
            val newer = occurrence("cached", "newer", group = "updated").copy(revision = 9)
            cache.replaceSnapshot(CalendarCacheSnapshot(window, listOf(newer), 300L))
            runCurrent()
            val projection = assertNotNull(lease.state.value.periods[period]?.projection)
            assertEquals(9, projection.visibleEvents.single().revision)
            assertEquals(listOf("updated"), projection.facets.groups)
            cache.replaceSnapshot(CalendarCacheSnapshot(window, listOf(newer.copy(revision = 1)), 200L))
            runCurrent()
            assertEquals(9, lease.state.value.periods[period]?.projection?.visibleEvents?.single()?.revision)
            repository.offline = false
            repository.pagesOverride = listOf(page(event(revision = 10)))
            experience.refresh()
            advanceUntilIdle()
            assertEquals(10, lease.state.value.periods[period]?.projection?.visibleEvents?.single()?.revision)
            // The fixture clock stays at 100: a new complete commit must still
            // outrank an already observed snapshot and its queued cache emission.
            cache.replaceSnapshot(CalendarCacheSnapshot(window, listOf(newer), 300L))
            runCurrent()
            assertEquals(10, lease.state.value.periods[period]?.projection?.visibleEvents?.single()?.revision)
            val identity = lease.state.value.periods[period]!!.projection!!.visibleEvents.single().let {
                CalendarOccurrenceIdentity(it.eventId, it.occurrenceId, it.originalStart!!, it.scope)
            }
            assertNotNull(lease.resolveOccurrence(identity))
            cache.purgeNamespace()
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(identity))
            assertEquals(null, lease.state.value.periods[period]?.projection)
        } finally { experience.close() }
    }

    @Test
    fun `viewport namespace purge auth expiry and close fence late noncooperative results`() = runTest {
        for (boundary in listOf("namespace", "purge", "auth", "close")) {
            val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
            val window = viewportWindow(period.anchorDate)
            val cache = FakeCacheStore(snapshot(window))
            val repository = FakeRepository(listOf(page(event(title = "late"))),
                beforePage = { CompletableDeferred<Unit>().await() }, swallowCancellation = true)
            val experience = experience(repository, cache, monthWindow(), this)
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(period))
            runCurrent()
            assertNotNull(lease.state.value.periods[period]?.projection)
            val identity = occurrence("cached", "cached").identity()
            assertNotNull(lease.resolveOccurrence(identity))
            assertTrue(lease.isActive, boundary)
            when (boundary) {
                "namespace" -> cache.switchNamespace(CalendarCacheNamespace("other", "other-backend"))
                "purge" -> experience.purgeNamespace()
                "auth" -> experience.expireAuthentication()
                else -> experience.close()
            }
            assertFalse(lease.isActive, boundary)
            assertEquals(null, lease.resolveOccurrence(identity), boundary)
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(identity), boundary)
            assertTrue(experience.viewportState.value.periods.isEmpty(), boundary)
            lease.setPeriods(listOf(period))
            runCurrent()
            assertTrue(experience.viewportState.value.periods.isEmpty(), boundary)
            assertFalse(lease.isActive, boundary)
            assertTrue("late" !in cache.replacementTitles, boundary)
            experience.close()
        }
    }

    @Test
    fun `viewport forbidden and auth responses invalidate foreground as well as all viewport periods`() = runTest {
        for (forbidden in listOf(true, false)) {
            val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
            val window = viewportWindow(period.anchorDate)
            val cache = FakeCacheStore(snapshot(window))
            val gate = CompletableDeferred<Unit>()
            val repository = FakeRepository(listOf(page()), beforePage = { gate.await() },
                forbiddenFailure = forbidden, authFailure = !forbidden)
            val experience = experience(repository, cache, window, this)
            try {
                experience.observe(window)
                val lease = experience.acquireViewport()
                lease.setPeriods(listOf(period))
                runCurrent()
                assertNotNull(experience.state.value.projection)
                assertNotNull(lease.state.value.periods[period]?.projection)
                val identity = occurrence("cached", "cached").identity()
                assertNotNull(lease.resolveOccurrence(identity))
                assertTrue(lease.isActive)
                gate.complete(Unit)
                advanceUntilIdle()
                assertFalse(lease.isActive)
                assertEquals(null, lease.resolveOccurrence(identity))
                assertTrue(experience.viewportState.value.periods.isEmpty())
                assertTrue(experience.state.value.authorizedOccurrences.isEmpty())
                assertEquals(null, cache.snapshotFor(window))
            } finally { experience.close() }
        }
    }

    @Test
    fun `viewport day week and neighboring month projections retain DST and exclusive end identities`() = runTest {
        val locale = CalendarLocale(timeZoneId = "America/New_York")
        val month = CalendarViewportPeriod(CalendarView.MONTH, "2024-03-01")
        val adjacent = CalendarViewportPeriod(CalendarView.MONTH, "2024-04-01")
        val day = CalendarViewportPeriod(CalendarView.DAY, "2024-03-10")
        val week = CalendarViewportPeriod(CalendarView.WEEK, "2024-03-10")
        val crossing = occurrence("crossing", "crossing").copy(start = "2024-03-31", end = "2024-04-02", originalStart = "2024-03-31")
        val dst = occurrence("dst", "DST").copy(start = "2024-03-10T06:30:00Z", end = "2024-03-11T04:00:00Z", originalStart = "2024-03-10T06:30:00Z")
        val cache = FakeCacheStore(snapshot(viewportWindow(month.anchorDate, locale), occurrences = listOf(crossing, dst)))
        cache.replaceSnapshot(snapshot(viewportWindow(adjacent.anchorDate, locale), occurrences = listOf(crossing)))
        val experience = CalendarExperience(FakeRepository(listOf(page())).also { it.offline = true }, cache,
            scope = this, initialLocale = locale, initialAnchorDate = "2024-03-10")
        try {
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(month, adjacent, day, week))
            advanceUntilIdle()
            val march = assertNotNull(lease.state.value.periods[month]?.projection?.month)
            val april = assertNotNull(lease.state.value.periods[adjacent]?.projection?.month)
            assertEquals(march.cells.single { it.date == "2024-03-31" }.events.single().actionIdentity,
                april.cells.single { it.date == "2024-03-31" }.events.single().actionIdentity)
            assertTrue(april.cells.single { it.date == "2024-04-02" }.events.isEmpty())
            assertTrue(march.cells.single { it.date == "2024-03-11" }.events.isEmpty())
            assertEquals("occurrence-dst", lease.state.value.periods[day]?.projection?.visibleEvents?.single()?.occurrenceId)
            assertEquals("occurrence-dst", lease.state.value.periods[week]?.projection?.visibleEvents?.single()?.occurrenceId)
        } finally { experience.close() }
    }

    @Test
    fun `viewport retains an LRU evicted visible snapshot but clears it on detectable purge`() = runTest {
        val period = CalendarViewportPeriod(CalendarView.MONTH, "2026-06-01")
        val window = viewportWindow(period.anchorDate)
        val cached = snapshot(window)
        val updates = MutableStateFlow<CalendarCacheReadResult<CalendarCacheSnapshot?>>(CalendarCacheResult.Success(cached))
        var retained = (0 until 12).map {
            CalendarCacheWindowMetadata(viewportWindow(addCalendarMonthsClamped("2027-01-01", it)),
                1L, 1L, CalendarFreshness.FRESH, 0)
        }
        val store = object : CalendarCacheStore by FakeCacheStore() {
            override fun observeSnapshot(window: CalendarCacheWindow) = updates
            override suspend fun readWindows() = CalendarCacheResult.Success(retained)
        }
        val repository = FakeRepository(listOf(page())).also { it.offline = true }
        val experience = CalendarExperience(repository, store, scope = this, initialAnchorDate = "2026-06-01")
        try {
            val lease = experience.acquireViewport()
            lease.setPeriods(listOf(period))
            advanceUntilIdle()
            val calls = repository.calls
            updates.value = CalendarCacheResult.Success(null)
            runCurrent()
            assertNotNull(lease.state.value.periods[period]?.projection)
            assertEquals(calls, repository.calls)
            assertEquals(cached.occurrences.single(), lease.resolveOccurrence(cached.occurrences.single().identity()))
            // A later observed snapshot followed by a purge is not LRU.
            updates.value = CalendarCacheResult.Success(cached.copy(fetchedAt = 2L))
            runCurrent()
            retained = emptyList()
            updates.value = CalendarCacheResult.Success(null)
            runCurrent()
            assertEquals(null, lease.resolveOccurrence(cached.occurrences.single().identity()))
            assertEquals(null, lease.state.value.periods[period]?.projection)
            assertEquals(calls, repository.calls)
            experience.close()
            assertTrue(lease.state.value.periods.isEmpty())
        } finally { experience.close() }
    }

    private fun EffectiveOccurrence.identity() = CalendarOccurrenceIdentity(eventId, occurrenceId, originalStart, scope)

    private fun viewportWindow(anchor: String, locale: CalendarLocale = CalendarLocale()): CalendarCacheWindow {
        val interval = calendarVisibleInterval(CalendarView.MONTH, anchor, locale)
        return CalendarCacheWindow(interval.startDate, interval.endExclusive, locale.timeZoneId)
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

    private inner class RecoveryRaceRepository : CalendarRepository {
        var armStaleRequest = false
        var staleCancelled = false
        var currentWindowCalls = 0
        val staleEntered = CompletableDeferred<Unit>()
        private var staleClaimed = false

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
            if (from == "2026-06-01" && to == "2026-07-01") currentWindowCalls++
            if (armStaleRequest && !staleClaimed && from == "2026-06-01" && to == "2026-07-01") {
                staleClaimed = true
                staleEntered.complete(Unit)
                try {
                    CompletableDeferred<Unit>().await()
                } catch (_: CancellationException) {
                    staleCancelled = true
                    return page(event(title = "old-stale-sentinel"))
                }
            }
            return page(event(title = if (armStaleRequest) "recovery-sentinel" else "prime-sentinel"))
        }

        override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?) =
            SentientResult.Failure(SentientError.Unknown("unused"))
        override suspend fun create(event: CalendarEvent) = error("unused")
        override suspend fun create(input: CalendarCreateInput) = error("unused")
        override suspend fun mutate(eventId: String, command: CalendarMutationCommand) = error("unused")
    }

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
        val cancelledWindows = mutableSetOf<Pair<String, String>>()
        var calls: Int = 0
        var cancelled: Boolean = false
        var offline: Boolean = false
        var mutationCancelled: Boolean = false
        var pagesOverride: List<SentientResult<CalendarEventPage>>? = null
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
            val activePages = pagesOverride ?: pages
            return activePages.getOrElse(pageIndex) { activePages.last() }
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
        val replacementTitles = mutableListOf<String?>()
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
            replacementTitles += occurrences.singleOrNull()?.title
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
