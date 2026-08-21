package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CalendarCacheFailureReason
import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheSnapshot
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.coroutines.cancellation.CancellationException as KotlinCancellationException
import kotlin.time.Clock as KtClock
import kotlin.time.Instant

/** Intents accepted by the shared, session-scoped calendar read coordinator. */
sealed interface CalendarExperienceIntent {
    data class Observe(val window: CalendarCacheWindow) : CalendarExperienceIntent
    data class Navigate(val action: CalendarNavigationAction) : CalendarExperienceIntent
    data class SetLocale(val locale: CalendarLocale) : CalendarExperienceIntent
    data object Refresh : CalendarExperienceIntent
}

typealias CalendarReadIntent = CalendarExperienceIntent

/** A page after the compatibility repository page has been converted losslessly. */
private data class EffectiveOccurrencePage(
    val occurrences: List<EffectiveOccurrence>,
    val nextCursor: String?,
)

private sealed interface AggregationResult {
    data class Complete(val occurrences: List<EffectiveOccurrence>) : AggregationResult
    data class Failed(val error: CalendarExperienceError) : AggregationResult
}

private data class CacheInputs(
    val snapshot: CalendarCacheResult<CalendarCacheSnapshot?>,
    val preferences: CalendarCacheResult<CalendarCachePreferences?>,
)

/**
 * One authenticated-session calendar read experience.
 *
 * The cache flows are started before remote work.  A remote response is folded
 * completely, with an explicit `all` scope, before one cache replacement.  No
 * repository state is retained: the repository remains a stateless transport
 * boundary and this class owns only observation/revalidation coordination.
 */
class CalendarExperience(
    private val repository: CalendarRepository,
    private val cacheStore: CalendarCacheStore,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    initialWindow: CalendarCacheWindow? = null,
    initialAnchorDate: String? = null,
    initialLocale: CalendarLocale = CalendarLocale(),
    private val nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
    private val todayDate: () -> String = ::defaultCalendarToday,
) {
    private val initialToday = validOrFallbackDate(todayDate(), initialAnchorDate ?: initialWindow?.windowStart)
    private val initialAnchor = validOrFallbackDate(initialAnchorDate, initialWindow?.windowStart ?: initialToday)
    private val initialState = CalendarExperienceState(
        anchorDate = initialAnchor,
        view = CalendarView.MONTH,
        selectedDate = initialAnchor,
        locale = initialLocale,
        todayDate = initialToday,
        visibleInterval = initialWindow?.toDateInterval() ?: calendarVisibleInterval(
            CalendarView.MONTH,
            initialAnchor,
            initialLocale,
        ),
        selectedInterval = selectedDateInterval(initialAnchor),
        mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.UNAVAILABLE),
    )

    private val _state = MutableStateFlow(initialState)
    val state: StateFlow<CalendarExperienceState> = _state.asStateFlow()
    val calendarState: StateFlow<CalendarExperienceState> get() = state
    val states: StateFlow<CalendarExperienceState> get() = state

    private var requestedWindow: CalendarCacheWindow = initialWindow ?: windowFor(
        presentation = initialState,
        timezoneInput = initialWindow?.timezoneInput ?: io.sentient.mobilesdk.calendar.CALENDAR_WIRE_TIME_ZONE,
    )
    private var activeWindow: CalendarCacheWindow = requestedWindow
    private var observationJob: Job? = null
    private var refreshJob: Job? = null
    private var revalidationGeneration: Long? = null
    private var requestGeneration: Long = 0L
    private var preferenceWriteGeneration: Long = 0L
    private var preferenceWriteJob: Job? = null
    private var closed: Boolean = false

    /** Compatibility constructor for callers that place the initial window before the coroutine scope. */
    constructor(
        repository: CalendarRepository,
        cacheStore: CalendarCacheStore,
        initialWindow: CalendarCacheWindow,
        scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        initialAnchorDate: String? = null,
        initialLocale: CalendarLocale = CalendarLocale(),
        nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
        todayDate: () -> String = ::defaultCalendarToday,
    ) : this(
        repository,
        cacheStore,
        scope,
        initialWindow,
        initialAnchorDate,
        initialLocale,
        nowMillis,
        todayDate,
    )

    /** The cache key currently used by the foreground observation. */
    val visibleWindow: CalendarCacheWindow get() = activeWindow
    val window: CalendarCacheWindow get() = activeWindow
    val isClosed: Boolean get() = closed

    /**
     * Begin or join observation of [window]. Equivalent active requests share
     * the same cache collectors and remote job; a different window cancels the
     * obsolete foreground aggregation before starting its replacement.
     */
    fun observe(window: CalendarCacheWindow = requestedWindow): StateFlow<CalendarExperienceState> {
        if (closed) return state
        if (requestedWindow == window && observationJob?.isActive == true) return state

        requestedWindow = window
        activeWindow = window
        requestGeneration += 1L
        observationJob?.cancel()
        refreshJob?.cancel()
        refreshJob = null
        revalidationGeneration = null
        markObservationStarted(window)

        val generation = requestGeneration
        observationJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            runObservation(window, generation)
        }
        return state
    }

    /** Source-compatible name for platform session/ViewModel callers. */
    fun start(window: CalendarCacheWindow = requestedWindow): StateFlow<CalendarExperienceState> = observe(window)

    /** Source-compatible request name used by thin native adapters. */
    fun requestWindow(window: CalendarCacheWindow): StateFlow<CalendarExperienceState> = observe(window)

    fun observe(interval: CalendarDateInterval, timezoneInput: String = activeWindow.timezoneInput): StateFlow<CalendarExperienceState> =
        observe(CalendarCacheWindow(interval.startDate, interval.endExclusive, timezoneInput))

    fun observe(windowStart: String, windowEnd: String, timezoneInput: String = activeWindow.timezoneInput): StateFlow<CalendarExperienceState> =
        observe(CalendarCacheWindow(windowStart, windowEnd, timezoneInput))

    fun dispatch(intent: CalendarExperienceIntent) {
        when (intent) {
            is CalendarExperienceIntent.Observe -> observe(intent.window)
            is CalendarExperienceIntent.Navigate -> dispatch(intent.action)
            is CalendarExperienceIntent.SetLocale -> dispatch(CalendarNavigationAction.SetLocale(intent.locale))
            CalendarExperienceIntent.Refresh -> refresh()
        }
    }

    fun send(intent: CalendarExperienceIntent) = dispatch(intent)
    fun onIntent(intent: CalendarExperienceIntent) = dispatch(intent)

    fun dispatch(action: CalendarNavigationAction) {
        if (closed) return
        val normalizedAction = try {
            when (action) {
                is CalendarNavigationAction.SetFilters -> action.copy(filters = validateFilters(action.filters))
                else -> action
            }
        } catch (_: IllegalArgumentException) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.CONTRACT,
                    userMessage = "The selected calendar filters are invalid.",
                ),
            )
            return
        }
        val current = _state.value
        val next = try {
            CalendarNavigation.reduce(current, normalizedAction).state
        } catch (_: IllegalArgumentException) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.CONTRACT,
                    userMessage = "The selected calendar position is invalid.",
                ),
            )
            return
        }
        val actionForWindow = normalizedAction
        applyPresentation(next)
        persistPresentation(next)

        // Filters are purely local over the complete cached set. View/date/locale
        // changes can alter the visible interval and are the only intents that
        // start a new foreground window request.
        val requiresWindow = actionForWindow !is CalendarNavigationAction.SetFilters
        val desiredWindow = windowFor(next, activeWindow.timezoneInput)
        if (requiresWindow && desiredWindow != activeWindow) observe(desiredWindow)
    }

    fun send(action: CalendarNavigationAction) = dispatch(action)
    fun onIntent(action: CalendarNavigationAction) = dispatch(action)

    fun today() = dispatch(CalendarNavigationAction.Today)
    fun previous() = dispatch(CalendarNavigationAction.Previous)
    fun next() = dispatch(CalendarNavigationAction.Next)
    fun selectDate(date: String) = dispatch(CalendarNavigationAction.SelectDate(date))
    fun selectMonth(year: Int, month: Int) = dispatch(CalendarNavigationAction.SelectMonth(year, month))
    fun selectView(view: CalendarView) = dispatch(CalendarNavigationAction.SelectView(view))
    fun setFilters(filters: CalendarFilters) = dispatch(CalendarNavigationAction.SetFilters(filters))
    fun setLocale(locale: CalendarLocale) = dispatch(CalendarNavigationAction.SetLocale(locale))

    /**
     * Coalesced explicit revalidation. The returned Job is useful to tests and
     * lifecycle owners; callers may ignore it when observation is long-lived.
     */
    fun refresh(): Job? {
        if (closed) return null
        if (observationJob?.isActive != true) {
            observe(requestedWindow)
        }
        refreshJob?.takeIf { it.isActive }?.let { return it }
        val generation = requestGeneration
        // The foreground observation may still be loading its preference/cache
        // flows. Let that same job launch the first revalidation after its
        // cache-first emission instead of racing it with a second request.
        if (observationJob?.isActive == true && revalidationGeneration != generation) {
            return observationJob
        }
        val window = activeWindow
        revalidationGeneration = generation
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            revalidate(window, generation)
        }
        refreshJob = job
        job.invokeOnCompletion {
            if (refreshJob === job) refreshJob = null
        }
        return job
    }

    fun refresh(window: CalendarCacheWindow): Job? {
        if (activeWindow != window || observationJob?.isActive != true) observe(window)
        return refresh()
    }

    fun refreshNow(): Job? = refresh()
    fun revalidate(window: CalendarCacheWindow): Job? = refresh(window)

    /** Stop all foreground/cache work without closing a caller-owned session scope. */
    fun close() {
        if (closed) return
        closed = true
        requestGeneration += 1L
        observationJob?.cancel()
        refreshJob?.cancel()
        preferenceWriteJob?.cancel()
        observationJob = null
        refreshJob = null
        revalidationGeneration = null
        preferenceWriteJob = null
        _state.value = initialState.copy(
            freshness = CalendarFreshness.STALE,
            offline = CalendarOfflineState.UNAVAILABLE,
            error = null,
            hasCompleteCache = false,
            cachedWindow = null,
            authorizedOccurrences = emptyList(),
            projection = null,
            facets = emptyCalendarFacets(),
            loading = CalendarLoadingState(),
            persistedCachePreferences = null,
            mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.UNAVAILABLE),
        )
    }

    private suspend fun runObservation(
        requested: CalendarCacheWindow,
        generation: Long,
    ) {
        // Preferences are read before selecting the first window so a restored
        // Month/Week/Day/Year view is the first remote request, not a follow-up.
        val preferenceRead = readPreferencesSafely()
        val restored = when (preferenceRead) {
            is CalendarCacheResult.Success -> preferenceRead.value?.let(::validatePreferences)
            is CalendarCacheResult.Failure -> null
        }
        if (!isCurrent(generation)) return

        if (preferenceRead is CalendarCacheResult.Failure) {
            updateError(cacheFailure(preferenceRead.error.reason))
        } else if (preferenceRead is CalendarCacheResult.Success && preferenceRead.value != null && restored == null) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.DECODE,
                    userMessage = "Saved calendar preferences could not be read.",
                ),
            )
        }

        val selectedWindow = restored?.let {
            windowFor(
                presentation = presentationFor(it),
                timezoneInput = requested.timezoneInput,
            )
        } ?: requested

        if (!isCurrent(generation)) return
        requestedWindow = selectedWindow
        activeWindow = selectedWindow
        if (restored != null) applyRestoredPreferences(restored, selectedWindow)
        observeWindow(selectedWindow, generation, restored)
    }

    private suspend fun observeWindow(
        window: CalendarCacheWindow,
        generation: Long,
        restored: CalendarCachePreferences?,
    ) = coroutineScope {
        val cacheReady = CompletableDeferred<Unit>()
        var latestSnapshot: CalendarCacheSnapshot? = null
        var hasSeenSnapshot = false
        var lastAppliedFetchedAt: Long? = null
        var latestPreferences: CalendarCachePreferences? = restored

        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                combine(
                    cacheStore.observeSnapshot(window),
                    cacheStore.observePreferences(),
                ) { snapshot, preferences -> CacheInputs(snapshot, preferences) }
                    .collect { inputs ->
                        if (!isCurrent(generation)) return@collect
                        val snapshotResult = inputs.snapshot
                        val preferencesResult = inputs.preferences

                        if (preferencesResult is CalendarCacheResult.Success) {
                            val normalized = preferencesResult.value?.let(::validatePreferences)
                            if (preferencesResult.value != null && normalized == null) {
                                updateError(
                                    CalendarExperienceError(
                                        kind = CalendarExperienceErrorKind.DECODE,
                                        userMessage = "Saved calendar preferences could not be read.",
                                    ),
                                )
                            } else if (normalized != null) {
                                latestPreferences = normalized
                            } else {
                                latestPreferences = null
                            }
                        } else if (preferencesResult is CalendarCacheResult.Failure) {
                            updateError(cacheFailure(preferencesResult.error.reason))
                        }

                        if (snapshotResult is CalendarCacheResult.Success) {
                            hasSeenSnapshot = true
                            if (snapshotResult.value != null) latestSnapshot = snapshotResult.value
                        } else if (snapshotResult is CalendarCacheResult.Failure) {
                            updateError(cacheFailure(snapshotResult.error.reason))
                        }

                        val snapshotChanged = latestSnapshot?.fetchedAt != lastAppliedFetchedAt
                        if (snapshotChanged) lastAppliedFetchedAt = latestSnapshot?.fetchedAt
                        applyCacheData(
                            window = window,
                            snapshot = latestSnapshot,
                            preferences = latestPreferences,
                            hasSeenSnapshot = hasSeenSnapshot,
                            snapshotChanged = snapshotChanged,
                        )
                        cacheReady.complete(Unit)
                    }
            } catch (cancelled: CancellationException) {
                cacheReady.cancel(cancelled)
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                cacheReady.cancel(cancelled)
                throw cancelled
            } catch (_: Throwable) {
                if (!cacheReady.isCompleted) cacheReady.complete(Unit)
                updateError(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.DATABASE,
                        userMessage = "Calendar cache is unavailable.",
                    ),
                )
            }
        }

        cacheReady.await()
        if (!isCurrent(generation) || !isActive) return@coroutineScope

        // A cache emission is now visible (including a typed empty result) before
        // any network call begins. This is the cache-first ordering contract.
        revalidationGeneration = generation
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) {
            revalidate(window, generation)
        }
        refreshJob = refresh
        refresh.invokeOnCompletion {
            if (refreshJob === refresh) refreshJob = null
        }

        try {
            awaitCancellation()
        } finally {
            collector.cancel()
            if (refreshJob === refresh) refreshJob = null
        }
    }

    private suspend fun revalidate(window: CalendarCacheWindow, generation: Long) {
        if (!isCurrent(generation)) return
        val hasCachedContent = _state.value.hasCompleteCache
        val retainedCacheError = _state.value.error?.takeIf {
            !hasCachedContent && it.kind in setOf(
                CalendarExperienceErrorKind.DECODE,
                CalendarExperienceErrorKind.DATABASE,
            )
        }
        _state.value = _state.value.copy(
            loading = CalendarLoadingState(
                if (hasCachedContent) CalendarLoadingPhase.REFRESHING else CalendarLoadingPhase.LOADING,
            ),
            freshness = CalendarFreshness.REFRESHING,
            offline = CalendarOfflineState.ONLINE,
            error = retainedCacheError,
            mutationAvailability = CalendarMutationAvailability(
                canCreate = hasCachedContent,
                canEdit = hasCachedContent,
                canDelete = hasCachedContent,
            ),
        )

        when (val aggregation = aggregate(window)) {
            is AggregationResult.Failed -> {
                if (!isCurrent(generation)) return
                val currentError = _state.value.error
                val hasCache = _state.value.hasCompleteCache
                val connection = aggregation.error.kind == CalendarExperienceErrorKind.CONNECTION
                val resultingError = if (
                    connection && !hasCache && currentError?.kind in setOf(
                        CalendarExperienceErrorKind.DECODE,
                        CalendarExperienceErrorKind.DATABASE,
                    )
                ) currentError else aggregation.error
                val resultingFreshness = if (connection) {
                    if (hasCache) CalendarFreshness.CACHED_OFFLINE else CalendarFreshness.OFFLINE
                } else {
                    CalendarFreshness.ERROR
                }
                if (hasCache) persistFreshness(window, resultingFreshness)
                _state.value = _state.value.copy(
                    loading = CalendarLoadingState(),
                    freshness = resultingFreshness,
                    offline = if (connection) {
                        if (hasCache) CalendarOfflineState.OFFLINE else CalendarOfflineState.UNAVAILABLE
                    } else {
                        CalendarOfflineState.ONLINE
                    },
                    error = resultingError,
                    mutationAvailability = unavailableMutationAvailability(
                        if (connection) CalendarMutationAvailabilityReason.OFFLINE
                        else if (aggregation.error.kind == CalendarExperienceErrorKind.AUTHORIZATION || aggregation.error.kind == CalendarExperienceErrorKind.FORBIDDEN) {
                            CalendarMutationAvailabilityReason.AUTHORIZATION
                        } else CalendarMutationAvailabilityReason.ERROR,
                    ),
                )
            }

            is AggregationResult.Complete -> {
                if (!isCurrent(generation)) return
                val fetchedAt = nowMillis().coerceAtLeast(0L)
                val writeResult = try {
                    cacheStore.replaceSnapshot(
                        window = window,
                        occurrences = aggregation.occurrences,
                        fetchedAt = fetchedAt,
                        lastAccessedAt = fetchedAt,
                        freshness = CalendarCacheFreshness.FRESH,
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (cancelled: KotlinCancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    CalendarCacheResult.Failure(
                        io.sentient.mobiledata.cache.CalendarCacheFailure(
                            CalendarCacheFailureReason.DATABASE,
                        ),
                    )
                }

                when (writeResult) {
                    is CalendarCacheResult.Success -> {
                        if (!isCurrent(generation)) return
                        // The SQLDelight flow naturally emits this generation. We
                        // also apply it here so a lightweight injected test store
                        // that acknowledges writes before emitting still exposes a
                        // complete fresh StateFlow value, never a first-page value.
                        applyCommittedData(window, aggregation.occurrences, fetchedAt)
                    }
                    is CalendarCacheResult.Failure -> {
                        if (!isCurrent(generation)) return
                        _state.value = _state.value.copy(
                            loading = CalendarLoadingState(),
                            freshness = CalendarFreshness.ERROR,
                            offline = CalendarOfflineState.ONLINE,
                            error = cacheFailure(writeResult.error.reason),
                            mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.ERROR),
                        )
                    }
                }
            }
        }
    }

    private suspend fun aggregate(window: CalendarCacheWindow): AggregationResult {
        val byIdentity = LinkedHashMap<String, EffectiveOccurrence>()
        val occurrenceIds = HashMap<String, String>()
        val seenCursors = HashSet<String>()
        var cursor: String? = null
        var pageCount = 0

        while (true) {
            if (++pageCount > MAX_PAGES) {
                return AggregationResult.Failed(contractError("Calendar pagination exceeded its safety bound."))
            }

            val result = try {
                repository.list(
                    from = window.windowStart,
                    to = window.windowEnd,
                    scope = CalendarScope.ALL,
                    group = null,
                    tags = null,
                    importance = null,
                    cursor = cursor,
                    query = null,
                    limit = null,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.CONNECTION,
                        userMessage = "Network unavailable. Cached calendar data is still shown.",
                    ),
                )
            }
            val page = when (result) {
                is SentientResult.Success -> result.data
                is SentientResult.Failure -> return AggregationResult.Failed(repositoryError(result.error))
                is SentientResult.Loading -> return AggregationResult.Failed(contractError("Calendar pagination did not return a settled page."))
            }

            val converted = try {
                convertPage(page)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: MalformedCalendarPageException) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.MALFORMED,
                        userMessage = "The calendar returned an invalid response.",
                    ),
                )
            } catch (_: Throwable) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.DECODE,
                        userMessage = "The calendar response could not be decoded.",
                    ),
                )
            }

            try {
                converted.occurrences.forEach { occurrence ->
                    val identity = CalendarOccurrenceIdentity(
                        eventId = occurrence.eventId,
                        occurrenceId = occurrence.occurrenceId,
                        originalStart = occurrence.originalStart,
                        scope = occurrence.scope,
                    )
                    val priorId = occurrenceIds[occurrence.occurrenceId]
                    if (priorId != null && priorId != identity.stableKey) {
                        throw ContractViolationException()
                    }
                    occurrenceIds[occurrence.occurrenceId] = identity.stableKey
                    val prior = byIdentity[identity.stableKey]
                    if (prior == null || occurrenceWins(occurrence, prior)) {
                        byIdentity[identity.stableKey] = occurrence
                    }
                }
            } catch (_: ContractViolationException) {
                return AggregationResult.Failed(contractError("Calendar pagination returned conflicting occurrence identity."))
            }

            val nextCursor = converted.nextCursor
            if (nextCursor == null) break
            if (nextCursor.isBlank() || !seenCursors.add(nextCursor)) {
                return AggregationResult.Failed(contractError("Calendar pagination returned a cursor loop."))
            }
            cursor = nextCursor
        }

        return AggregationResult.Complete(
            byIdentity.values.sortedWith(
                compareBy<EffectiveOccurrence> { it.start }
                    .thenBy { it.eventId }
                    .thenBy { it.occurrenceId },
            ),
        )
    }

    private fun convertPage(page: CalendarEventPage): EffectiveOccurrencePage {
        if (page.nextCursor?.isBlank() == true) throw MalformedCalendarPageException()
        return EffectiveOccurrencePage(
            occurrences = page.events.map(::toEffectiveOccurrence),
            nextCursor = page.nextCursor,
        )
    }

    private fun toEffectiveOccurrence(event: CalendarEvent): EffectiveOccurrence {
        val eventId = event.eventId
        val occurrenceId = event.occurrenceId ?: eventId
        val start = event.start.toWireValue()
        val originalStart = event.originalStart?.toWireValue() ?: start
        val end = event.end?.toWireValue()
        if (eventId.isBlank() || occurrenceId.isBlank() || originalStart.isBlank() || start.isBlank()) {
            throw MalformedCalendarPageException()
        }
        if (event.revision < 0 || end?.isBlank() == true) throw MalformedCalendarPageException()
        validateTemporal(originalStart)
        validateTemporal(start)
        end?.let(::validateTemporal)
        return EffectiveOccurrence(
            eventId = eventId,
            occurrenceId = occurrenceId,
            originalStart = originalStart,
            recurring = event.recurrence != null || event.occurrenceId != null || event.originalStart != null,
            revision = event.revision,
            scope = event.scope,
            title = event.title,
            description = event.description,
            start = start,
            end = end,
            visibility = event.visibility,
            importance = event.importance,
            group = event.group,
            tags = event.tags,
            recurrence = event.recurrence,
        )
    }

    private fun validateTemporal(value: String) {
        if (CalendarDates.isValid(value)) return
        try {
            Instant.parse(value)
        } catch (_: IllegalArgumentException) {
            throw MalformedCalendarPageException()
        }
    }

    private fun occurrenceWins(candidate: EffectiveOccurrence, prior: EffectiveOccurrence): Boolean =
        compareValuesBy(candidate, prior, { it.revision }, { it.start }, { it.title }, { it.eventId }) > 0

    private fun applyCacheData(
        window: CalendarCacheWindow,
        snapshot: CalendarCacheSnapshot?,
        preferences: CalendarCachePreferences?,
        hasSeenSnapshot: Boolean,
        snapshotChanged: Boolean,
    ) {
        if (closed) return
        val current = _state.value
        val occurrences = snapshot?.occurrences ?: current.authorizedOccurrences
        val hasCache = snapshot != null || (current.hasCompleteCache && current.cachedWindow == window && hasSeenSnapshot)
        val nextPresentation = preferences?.let(::presentationFor)
        val base = nextPresentation ?: current
        val projection = buildProjection(base, occurrences)
        val next = current.copy(
            anchorDate = base.anchorDate,
            view = base.view,
            selectedDate = base.selectedDate,
            filters = base.filters,
            locale = base.locale,
            todayDate = base.todayDate,
            visibleInterval = window.toDateInterval(),
            selectedInterval = selectedDateInterval(base.selectedDate),
            authorizedOccurrences = occurrences,
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            hasCompleteCache = hasCache,
            cachedWindow = snapshot?.window ?: current.cachedWindow,
            persistedCachePreferences = preferences ?: current.persistedCachePreferences,
            loading = if (snapshot != null && current.loading.phase == CalendarLoadingPhase.LOADING) CalendarLoadingState() else current.loading,
            freshness = if (snapshotChanged && snapshot != null) snapshot.freshness else current.freshness,
            error = if (snapshotChanged && snapshot?.freshness == CalendarFreshness.FRESH) null else current.error,
            offline = if (snapshotChanged && snapshot != null) CalendarOfflineState.ONLINE else current.offline,
            mutationAvailability = if (snapshot != null && snapshotChanged && current.error == null) {
                CalendarMutationAvailability()
            } else {
                current.mutationAvailability
            },
        )
        _state.value = next
    }

    private fun applyCommittedData(
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
    ) {
        val current = _state.value
        val projection = buildProjection(current, occurrences)
        _state.value = current.copy(
            visibleInterval = window.toDateInterval(),
            authorizedOccurrences = occurrences,
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            freshness = CalendarFreshness.FRESH,
            loading = CalendarLoadingState(),
            offline = CalendarOfflineState.ONLINE,
            error = null,
            hasCompleteCache = true,
            cachedWindow = window,
            mutationAvailability = CalendarMutationAvailability(),
        )
        // The generation marker is deliberately represented by the persisted
        // cache snapshot, not by a second in-memory page cache.
        @Suppress("UNUSED_VARIABLE")
        val committedAt = fetchedAt
    }

    private fun applyPresentation(next: CalendarExperienceState) {
        val current = _state.value
        val projection = buildProjection(next, current.authorizedOccurrences)
        _state.value = current.copy(
            anchorDate = next.anchorDate,
            view = next.view,
            selectedDate = next.selectedDate,
            filters = next.filters,
            locale = next.locale,
            todayDate = next.todayDate,
            visibleInterval = calendarVisibleInterval(next.view, next.anchorDate, next.locale),
            selectedInterval = selectedDateInterval(next.selectedDate),
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            // A local filter/view intent is immediately usable over cached data.
            error = current.error,
        )
    }

    private fun persistPresentation(presentation: CalendarExperienceState) {
        val cachePreferences = presentation.toCachePreferences(nowMillis().coerceAtLeast(0L))
        val generation = ++preferenceWriteGeneration
        preferenceWriteJob?.cancel()
        val writeJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val result = try {
                cacheStore.writePreferences(cachePreferences)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                CalendarCacheResult.Failure(
                    io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
                )
            }
            if (closed || generation != preferenceWriteGeneration) return@launch
            if (result is CalendarCacheResult.Failure) updateError(cacheFailure(result.error.reason))
            else _state.value = _state.value.copy(persistedCachePreferences = cachePreferences)
        }
        preferenceWriteJob = writeJob
        writeJob.invokeOnCompletion {
            if (preferenceWriteJob === writeJob) preferenceWriteJob = null
        }
    }

    private fun markObservationStarted(window: CalendarCacheWindow) {
        val current = _state.value
        val sameCachedWindow = current.hasCompleteCache && current.cachedWindow == window
        val base = if (!sameCachedWindow && current.hasCompleteCache) {
            // A different visible interval must not render the previous window's
            // events as if they belonged to the new one. Same-window refreshes
            // take the stale-while-revalidate path below and retain content.
            val emptyProjection = buildProjection(current, emptyList())
            current.copy(
                authorizedOccurrences = emptyList(),
                projection = emptyProjection,
                facets = emptyProjection?.facets ?: emptyCalendarFacets(),
                hasCompleteCache = false,
                cachedWindow = null,
            )
        } else {
            current
        }
        _state.value = base.copy(
            visibleInterval = window.toDateInterval(),
            loading = CalendarLoadingState(
                if (sameCachedWindow) CalendarLoadingPhase.REFRESHING else CalendarLoadingPhase.LOADING,
            ),
            freshness = if (sameCachedWindow) CalendarFreshness.REFRESHING else current.freshness,
            error = null,
            offline = CalendarOfflineState.ONLINE,
        )
    }

    private fun updateError(error: CalendarExperienceError) {
        if (closed) return
        _state.value = _state.value.copy(error = error)
    }

    private suspend fun readPreferencesSafely(): CalendarCacheResult<CalendarCachePreferences?> = try {
        cacheStore.readPreferences()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (cancelled: KotlinCancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        CalendarCacheResult.Failure(
            io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
        )
    }

    private fun buildProjection(
        presentation: CalendarExperienceState,
        occurrences: List<EffectiveOccurrence>,
    ): CalendarExperienceProjection? = try {
        projectCalendar(
            occurrences = occurrences,
            anchorDate = presentation.anchorDate,
            view = presentation.view,
            selectedDate = presentation.selectedDate,
            todayDate = presentation.todayDate,
            locale = presentation.locale,
            filters = presentation.filters,
        )
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun presentationFor(preferences: CalendarCachePreferences): CalendarExperienceState {
        val current = _state.value
        val pure = preferences.toCalendarPreferences().copy(
            selectedDate = preferences.anchorDate,
            locale = current.locale,
        )
        return current.copy(
            anchorDate = pure.anchorDate,
            view = pure.view,
            selectedDate = pure.selectedDate,
            filters = pure.filters,
            locale = pure.locale,
            todayDate = current.todayDate,
        )
    }

    private fun applyRestoredPreferences(preferences: CalendarCachePreferences, window: CalendarCacheWindow) {
        val current = _state.value
        val next = presentationFor(preferences)
        val projection = buildProjection(next, current.authorizedOccurrences)
        _state.value = current.copy(
            anchorDate = next.anchorDate,
            view = next.view,
            selectedDate = next.selectedDate,
            filters = next.filters,
            visibleInterval = window.toDateInterval(),
            selectedInterval = selectedDateInterval(next.selectedDate),
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            persistedCachePreferences = preferences,
        )
    }

    private fun validatePreferences(value: CalendarCachePreferences): CalendarCachePreferences? = try {
        require(CalendarDates.isValid(value.anchorDate))
        require(value.updatedAt >= 0L)
        require(value.scopes.isNotEmpty())
        require(value.groups.size <= MAX_FILTER_VALUES && value.tags.size <= MAX_FILTER_VALUES)
        require(value.groups.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(value.tags.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(value.searchText.length <= MAX_SEARCH_LENGTH)
        val scopes = value.scopes.distinct().let { values ->
            if (CalendarScope.ALL in values) listOf(CalendarScope.ALL) else values.sortedBy { it.ordinal }
        }
        value.copy(
            scopes = scopes,
            groups = value.groups.distinct().sorted(),
            tags = value.tags.distinct().sorted(),
        )
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun validateFilters(filters: CalendarFilters): CalendarFilters {
        require(filters.text.length <= MAX_SEARCH_LENGTH)
        require(filters.groups.size <= MAX_FILTER_VALUES && filters.tags.size <= MAX_FILTER_VALUES)
        require(filters.groups.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(filters.tags.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        return filters.copy(
            groups = filters.groups.map(String::trim).distinct().sorted().toSet(),
            tags = filters.tags.map(String::trim).distinct().sorted().toSet(),
            text = filters.text,
        )
    }

    private fun CalendarExperienceState.toCachePreferences(updatedAt: Long): CalendarCachePreferences = CalendarCachePreferences(
        view = view,
        anchorDate = anchorDate,
        scopes = listOf(filters.scope),
        groups = filters.groups.toList(),
        tags = filters.tags.toList(),
        importance = filters.importance,
        searchText = filters.text,
        updatedAt = updatedAt,
    )

    private fun repositoryError(error: SentientError): CalendarExperienceError {
        val message = error.userMessage.lowercase()
        return when (error) {
            is SentientError.Connection,
            is SentientError.Timeout,
            -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.CONNECTION,
                userMessage = "Network unavailable. Cached calendar data is still shown.",
            )
            is SentientError.Auth -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.AUTHORIZATION,
                userMessage = "Your session expired. Please sign in again.",
                recoverable = false,
            )
            is SentientError.Protocol -> when {
                "forbidden" in message || "permission" in message -> CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.FORBIDDEN,
                    userMessage = "You do not have permission to read this calendar.",
                )
                "malformed" in message || "decode" in message || "invalid response" in message -> CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.MALFORMED,
                    userMessage = "The calendar returned an invalid response.",
                )
                else -> contractError("The calendar request could not be completed.")
            }
            is SentientError.Cycle -> contractError("Calendar pagination could not be completed.")
            is SentientError.Unknown -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.UNKNOWN,
                userMessage = "The calendar could not be loaded.",
            )
            is SentientError.Outbox -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.UNKNOWN,
                userMessage = "The calendar could not be loaded.",
            )
        }
    }

    private suspend fun persistFreshness(window: CalendarCacheWindow, freshness: CalendarFreshness) {
        try {
            cacheStore.markFreshness(window, freshness)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The in-memory state remains authoritative for this observation;
            // a metadata-only persistence failure must not hide cached events.
        }
    }

    private fun cacheFailure(reason: CalendarCacheFailureReason): CalendarExperienceError = when (reason) {
        CalendarCacheFailureReason.DECODE,
        CalendarCacheFailureReason.INVALID_PREFERENCES,
        CalendarCacheFailureReason.INVALID_SNAPSHOT,
        -> CalendarExperienceError(
            kind = CalendarExperienceErrorKind.DECODE,
            userMessage = "Saved calendar data could not be decoded.",
        )
        CalendarCacheFailureReason.INVALID_WINDOW,
        CalendarCacheFailureReason.INVALID_NAMESPACE,
        -> contractError("The calendar cache key is invalid.")
        CalendarCacheFailureReason.CLOSED,
        CalendarCacheFailureReason.DATABASE,
        CalendarCacheFailureReason.NOT_FOUND,
        -> CalendarExperienceError(
            kind = CalendarExperienceErrorKind.DATABASE,
            userMessage = "Calendar cache is unavailable.",
        )
    }

    private fun contractError(message: String) = CalendarExperienceError(
        kind = CalendarExperienceErrorKind.CONTRACT,
        userMessage = message,
    )

    private fun unavailableMutationAvailability(reason: CalendarMutationAvailabilityReason) = CalendarMutationAvailability(
        canCreate = false,
        canEdit = false,
        canDelete = false,
        reason = reason,
    )

    private fun isCurrent(generation: Long): Boolean = !closed && generation == requestGeneration && activeWindow == requestedWindow

    private fun windowFor(presentation: CalendarExperienceState, timezoneInput: String): CalendarCacheWindow {
        val interval = calendarVisibleInterval(presentation.view, presentation.anchorDate, presentation.locale)
        return CalendarCacheWindow(interval.startDate, interval.endExclusive, timezoneInput)
    }

    private fun selectedDateInterval(date: String): CalendarDateInterval = CalendarDateInterval(
        startDate = date,
        endExclusive = CalendarDates.addDays(date, 1),
    )

    private fun CalendarCacheWindow.toDateInterval(): CalendarDateInterval = CalendarDateInterval(windowStart, windowEnd)

    private class MalformedCalendarPageException : Exception()
    private class ContractViolationException : Exception()

    private companion object {
        const val MAX_PAGES = 10_000
        const val MAX_FILTER_VALUE_LENGTH = 256
        const val MAX_FILTER_VALUES = 128
        const val MAX_SEARCH_LENGTH = 512
    }
}

/** A factory seam for authenticated session construction before platform drivers are wired. */
fun interface CalendarExperienceFactory {
    fun create(repository: CalendarRepository): CalendarExperience
}

class DefaultCalendarExperienceFactory(
    private val cacheStore: CalendarCacheStore,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val initialWindow: CalendarCacheWindow? = null,
    private val initialLocale: CalendarLocale = CalendarLocale(),
) : CalendarExperienceFactory {
    override fun create(repository: CalendarRepository): CalendarExperience = CalendarExperience(
        repository = repository,
        cacheStore = cacheStore,
        scope = scope,
        initialWindow = initialWindow,
        initialLocale = initialLocale,
    )
}

fun createCalendarExperience(
    repository: CalendarRepository,
    cacheStore: CalendarCacheStore,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    initialWindow: CalendarCacheWindow? = null,
    initialAnchorDate: String? = null,
    initialLocale: CalendarLocale = CalendarLocale(),
    nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
    todayDate: () -> String = ::defaultCalendarToday,
): CalendarExperience = CalendarExperience(
    repository = repository,
    cacheStore = cacheStore,
    scope = scope,
    initialWindow = initialWindow,
    initialAnchorDate = initialAnchorDate,
    initialLocale = initialLocale,
    nowMillis = nowMillis,
    todayDate = todayDate,
)

private fun defaultCalendarToday(): String = KtClock.System.now()
    .toLocalDateTime(TimeZone.UTC)
    .date
    .toString()

private fun validOrFallbackDate(value: String?, fallback: String?): String {
    val candidate = value?.takeIf(CalendarDates::isValid)
    if (candidate != null) return candidate
    val safeFallback = fallback?.takeIf(CalendarDates::isValid)
    return safeFallback ?: "1970-01-01"
}
