package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CALENDAR_CACHE_MAX_RETAINED_WINDOWS
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheSnapshot
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.di.CalendarLifecycleLock
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull

private const val MAX_VIEWPORT_PERIODS = 48

/** Unvalidated civil rendering input. Year surfaces request MONTH units, not whole years. */
data class CalendarViewportPeriod(val view: CalendarView, val anchorDate: String)

/** Expected request outcomes, safe to consume through the non-throwing native bridge. */
enum class CalendarViewportRequestResult {
    ACCEPTED,
    INVALID_DATE,
    /** SelectDate is valid civil input but outside the browsed locale-aware week. */
    OUTSIDE_VISIBLE_WEEK,
    UNSUPPORTED_VIEW,
    UNSUPPORTED_ACTION,
    TOO_MANY_PERIODS,
    RETIRED,
}

data class CalendarViewportEntry(
    val window: CalendarCacheWindow,
    /** Null means unknown/unavailable, never a proven empty calendar. */
    val projection: CalendarExperienceProjection? = null,
    val loading: CalendarLoadingState = CalendarLoadingState(CalendarLoadingPhase.LOADING),
    val freshness: CalendarFreshness = CalendarFreshness.STALE,
    val offline: CalendarOfflineState = CalendarOfflineState.UNAVAILABLE,
    val error: CalendarExperienceError? = null,
)

data class CalendarViewportState(
    val periods: Map<CalendarViewportPeriod, CalendarViewportEntry> = emptyMap(),
)

/**
 * One native route's read-only viewport. Acquiring a successor lease retires the
 * previous one; its later set/close calls are inert. Closing releases all data.
 * Requests do not select dates, navigate, write preferences or replace observe().
 */
class CalendarViewportLease internal constructor(
    val state: StateFlow<CalendarViewportState>,
    private val request: (List<CalendarViewportPeriod>) -> CalendarViewportRequestResult,
    private val release: () -> Unit,
    private val resolve: (CalendarOccurrenceIdentity) -> EffectiveOccurrence?,
    private val active: () -> Boolean,
) {
    /** Prioritize visible units, then overscan. Rejections leave the previous request unchanged. */
    fun setPeriods(periods: List<CalendarViewportPeriod>): CalendarViewportRequestResult = request(periods)

    /**
     * Synchronous, nonthrowing action lookup in this current lease's published
     * visible periods. Exact identity includes originalStart and scope, not revision.
     * Returns the reconciled raw winner only while publication, presentation and
     * authority fences are current; missing/filtered/unknown/retired data returns null.
     * Cached/offline records retain the existing cache authority policy.
     */
    fun resolveOccurrence(identity: CalendarOccurrenceIdentity): EffectiveOccurrence? = resolve(identity)

    fun close() = release()

    /**
     * Synchronous local lease authority, checked under the lifecycle lock.
     * Empty requests, foreground loading and pending projection updates do not
     * deactivate a lease. This does not imply occurrence/publication currency.
     */
    val isActive: Boolean get() = active()

    val maximumPeriods: Int get() = MAX_VIEWPORT_PERIODS
}

internal data class CalendarViewportPresentation(
    val locale: CalendarLocale,
    val filters: CalendarFilters,
    val selectedDate: String,
    val todayDate: String,
)

internal sealed interface CalendarViewportLoadResult {
    data object Complete : CalendarViewportLoadResult
    data object Cancelled : CalendarViewportLoadResult
    data class Failed(val error: CalendarExperienceError) : CalendarViewportLoadResult
}

/** Bounded observers/projections only; transport and persistent cache policy stay in the experience. */
internal class CalendarViewportCoordinator(
    private val cache: CalendarCacheStore,
    private val scope: CoroutineScope,
    private val presentation: StateFlow<CalendarExperienceState>,
    private val captureFence: () -> (() -> Boolean),
    private val windowFor: (CalendarViewportPeriod, CalendarLocale) -> CalendarCacheWindow,
    private val load: suspend (CalendarCacheWindow, () -> Boolean) -> CalendarViewportLoadResult,
    private val viewed: suspend (CalendarCacheSnapshot, () -> Boolean) -> Unit,
) {
    private val lock = CalendarLifecycleLock()
    private val mutableState = MutableStateFlow(CalendarViewportState())
    val state = mutableState.asStateFlow()
    private var owner = 0L
    private var publication = 0L
    private var published = -1L
    private var periods = emptyList<CalendarViewportPeriod>()
    private var presentationJob: Job? = null
    private val windows = linkedMapOf<CalendarCacheWindow, Window>()
    private val permits = Semaphore(2)
    private var projected = emptyMap<CalendarViewportPeriod, Prepared>()

    private class Window(val key: CalendarCacheWindow, val authorized: () -> Boolean) {
        var snapshot: CalendarCacheSnapshot? = null
        var observer: Job? = null
        var loader: Job? = null
        var loadGeneration = 0L
        var cacheReady = false
        var loading = true
        var error: CalendarExperienceError? = null
    }

    private data class Prepared(
        val snapshot: CalendarCacheSnapshot?,
        val presentation: CalendarViewportPresentation,
        val entry: CalendarViewportEntry,
        val occurrences: List<EffectiveOccurrence>? = null,
        val visibleOccurrences: Map<CalendarOccurrenceIdentity, EffectiveOccurrence> = emptyMap(),
    )

    // Only called inside the short lifecycle lock. No I/O or projection is run there.
    private fun current(window: Window) = windows[window.key] === window && window.authorized()

    fun acquire(): CalendarViewportLease {
        val leaseOwner = clear()
        val valid = captureFence()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            presentation.map { it.viewportPresentation() }.distinctUntilChanged().collect {
                reconcile(leaseOwner, valid)
            }
        }
        val installed = lock.withLock {
            if (owner != leaseOwner || !valid()) false else { presentationJob = job; true }
        }
        if (installed) job.start() else job.cancel()
        return CalendarViewportLease(state, { requested ->
            val result = lock.withLock {
                when {
                    owner != leaseOwner || !valid() -> CalendarViewportRequestResult.RETIRED
                    // Four-column native mini-months, ten visible rows plus
                    // one overscan row per edge. Disk still retains 12 windows.
                    requested.size > MAX_VIEWPORT_PERIODS -> CalendarViewportRequestResult.TOO_MANY_PERIODS
                    requested.any { it.view == CalendarView.YEAR } -> CalendarViewportRequestResult.UNSUPPORTED_VIEW
                    requested.any { !isViewportDate(it.anchorDate) } -> CalendarViewportRequestResult.INVALID_DATE
                    else -> {
                        periods = requested.distinct()
                        publication++
                        CalendarViewportRequestResult.ACCEPTED
                    }
                }
            }
            if (result == CalendarViewportRequestResult.ACCEPTED) reconcile(leaseOwner, valid)
            result
        }, { clear(leaseOwner); Unit }, { identity -> resolveOccurrence(leaseOwner, valid, identity) }, {
            lock.withLock { owner == leaseOwner && valid() }
        })
    }

    private fun resolveOccurrence(
        leaseOwner: Long,
        valid: () -> Boolean,
        identity: CalendarOccurrenceIdentity,
    ): EffectiveOccurrence? = lock.withLock {
        if (owner != leaseOwner || !valid() || published != publication) return@withLock null
        val source = presentation.value.viewportPresentation()
        for (period in periods) {
            val prepared = projected[period] ?: continue
            if (prepared.presentation != source) return@withLock null
            val window = windows[prepared.entry.window] ?: return@withLock null
            if (!current(window) || window.snapshot !== prepared.snapshot) return@withLock null
            val occurrence = prepared.visibleOccurrences[identity] ?: continue
            // Presentation/namespace inputs can change outside this coordinator's lock.
            return@withLock occurrence.takeIf { valid() && source == presentation.value.viewportPresentation() }
        }
        null
    }

    /** Synchronous authority/lifetime fence, including retained evicted snapshots. */
    fun clear(expectedOwner: Long? = null): Long {
        val (clearedOwner, obsolete) = lock.withLock {
            if (expectedOwner != null && owner != expectedOwner) return@withLock owner to emptyList<Job>()
            owner++
            publication++
            val jobs = listOfNotNull(presentationJob) + windows.values.flatMap { listOfNotNull(it.observer, it.loader) }
            presentationJob = null
            periods = emptyList()
            windows.clear()
            projected = emptyMap()
            mutableState.value = CalendarViewportState()
            owner to jobs
        }
        obsolete.forEach { it.cancel() }
        return clearedOwner
    }

    private fun reconcile(leaseOwner: Long, valid: () -> Boolean) {
        val added = mutableListOf<Window>()
        val obsolete = mutableListOf<Job>()
        lock.withLock {
            if (owner != leaseOwner || !valid()) return@withLock
            val desired = periods.map { windowFor(it, presentation.value.locale) }.toSet()
            windows.keys.filter { it !in desired }.forEach { key ->
                windows.remove(key)?.let { obsolete += listOfNotNull(it.observer, it.loader) }
            }
            desired.forEach { key ->
                if (key !in windows) Window(key, valid).also { windows[key] = it; added += it }
            }
            publication++
        }
        obsolete.forEach { it.cancel() }
        publish()
        added.forEach(::observe)
    }

    private fun observe(window: Window) {
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                cache.observeSnapshot(window.key).collect { result ->
                    if (!lock.withLock { current(window) }) return@collect
                    val previousSnapshot = lock.withLock { window.snapshot }
                    var eviction = false
                    if (result is CalendarCacheResult.Success && result.value == null && previousSnapshot != null) {
                        // Full-store disappearance is LRU, not authority loss.
                        // A purge/empty store clears retained content. Explicit
                        // experience auth purges additionally clear synchronously.
                        val metadata = withTimeoutOrNull(5_000L) { cache.readWindows() }
                        eviction = metadata is CalendarCacheResult.Success &&
                            metadata.value.size >= CALENDAR_CACHE_MAX_RETAINED_WINDOWS &&
                            metadata.value.none { it.window == window.key }
                    }
                    val first = lock.withLock {
                        if (!current(window)) return@withLock false
                        when (result) {
                            is CalendarCacheResult.Success -> {
                                val incoming = result.value
                                if (incoming != null) {
                                    if (incoming.fetchedAt >= (window.snapshot?.fetchedAt ?: -1L)) {
                                        if (incoming != window.snapshot && incoming.freshness == CalendarFreshness.FRESH) window.error = null
                                        window.snapshot = incoming
                                    }
                                } else if (!eviction && window.snapshot === previousSnapshot) window.snapshot = null
                            }
                            is CalendarCacheResult.Failure -> window.error = cacheError()
                        }
                        window.cacheReady = true
                        publication++
                        window.loader == null
                    }
                    publish()
                    if (result is CalendarCacheResult.Success) {
                        result.value?.takeIf { it.fetchedAt != previousSnapshot?.fetchedAt }?.let { snapshot ->
                            viewed(snapshot) { lock.withLock { current(window) } }
                        }
                    }
                    if (first) startLoad(window)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                val first = lock.withLock {
                    if (!current(window)) return@withLock false
                    window.error = cacheError()
                    window.cacheReady = true
                    publication++
                    window.loader == null
                }
                publish()
                if (first) startLoad(window)
            }
        }
        val installed = lock.withLock {
            if (!current(window)) false else { window.observer = job; true }
        }
        if (installed) job.start() else job.cancel()
    }

    private fun startLoad(window: Window) {
        val attempt = lock.withLock { ++window.loadGeneration }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            permits.withPermit {
                val valid = lock.withLock {
                    if (!current(window) || attempt != window.loadGeneration) false else {
                        window.loading = true
                        window.error = null
                        publication++
                        true
                    }
                }
                if (!valid) return@withPermit
                publish()
                val result = load(window.key) {
                    lock.withLock { current(window) && attempt == window.loadGeneration }
                }
                lock.withLock {
                    if (current(window) && attempt == window.loadGeneration) {
                        if (result is CalendarViewportLoadResult.Failed) window.error = result.error
                        window.loading = false
                        publication++
                    }
                }
                publish()
            }
        }
        var previous: Job? = null
        val installed = lock.withLock {
            if (!current(window) || attempt != window.loadGeneration) false else {
                previous = window.loader
                window.loader = job
                true
            }
        }
        previous?.cancel()
        if (installed) job.start() else job.cancel()
    }

    fun contains(key: CalendarCacheWindow): Boolean = lock.withLock { windows[key]?.let(::current) == true }

    fun fetchedAt(key: CalendarCacheWindow): Long = lock.withLock {
        windows[key]?.takeIf(::current)?.snapshot?.fetchedAt ?: -1L
    }

    /** Refresh/recovery/local mutation use the same loader; cache observers stay attached. */
    fun refresh() = lock.withLock { windows.values.filter { it.cacheReady } }.forEach(::startLoad)

    /** Called at the existing complete-write boundary, also for non-emitting stores. */
    fun committed(key: CalendarCacheWindow, occurrences: List<EffectiveOccurrence>, fetchedAt: Long, valid: () -> Boolean) {
        lock.withLock {
            val window = windows[key] ?: return@withLock
            if (!valid() || !current(window) || fetchedAt < (window.snapshot?.fetchedAt ?: -1L)) return@withLock
            window.snapshot = CalendarCacheSnapshot(key, occurrences, fetchedAt, fetchedAt, CalendarFreshness.FRESH)
            window.error = null
            window.loading = false
            publication++
        }
        publish()
    }

    private fun publish() {
        val inputs = lock.withLock {
            val source = presentation.value.viewportPresentation()
            val sequence = ++publication
            val entries = periods.mapNotNull { period ->
                val window = windows[windowFor(period, source.locale)] ?: return@mapNotNull null
                if (!current(window)) return@mapNotNull null
                val snapshot = window.snapshot
                val connection = window.error?.kind == CalendarExperienceErrorKind.CONNECTION
                val error = if (connection && snapshot == null) CalendarExperienceError(
                    CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE, "This calendar period is not available offline.",
                ) else window.error
                val entry = CalendarViewportEntry(
                    window = window.key,
                    loading = CalendarLoadingState(if (!window.loading) CalendarLoadingPhase.IDLE
                        else if (snapshot == null) CalendarLoadingPhase.LOADING else CalendarLoadingPhase.REFRESHING),
                    freshness = when {
                        connection && snapshot == null -> CalendarFreshness.UNAVAILABLE_OFFLINE
                        connection -> CalendarFreshness.CACHED_OFFLINE
                        error != null -> CalendarFreshness.ERROR
                        window.loading -> CalendarFreshness.REFRESHING
                        else -> snapshot?.freshness ?: CalendarFreshness.STALE
                    },
                    offline = when {
                        snapshot == null -> CalendarOfflineState.UNAVAILABLE
                        connection -> CalendarOfflineState.OFFLINE
                        else -> CalendarOfflineState.ONLINE
                    },
                    error = error,
                )
                Triple(period, Prepared(snapshot, source, entry), projected[period])
            }
            Triple(sequence, source, entries)
        }
        val source = inputs.second
        val winners = viewportOccurrenceWinners(inputs.third.mapNotNull { it.second.snapshot }.distinctBy { it.window })
        val prepared = inputs.third.associate { (period, next, prior) ->
            // Preserve this complete authorized window's membership. Winners
            // replace existing identities only; they never union data into an
            // empty/deleted/revoked/moved-away window.
            val occurrences = next.snapshot?.occurrences?.map { winners.getValue(it.viewportIdentity()) }
            val entry = try {
                val projection = if (prior != null && prior.occurrences == occurrences &&
                    prior.presentation == source && prior.entry.projection != null
                ) {
                    prior.entry.projection
                } else occurrences?.let {
                    projectCalendar(it, period.anchorDate, period.view,
                        source.selectedDate, source.todayDate, source.locale, source.filters)
                }
                next.entry.copy(projection = projection)
            } catch (_: IllegalArgumentException) {
                // Same adapter boundary as foreground projection: invalid
                // custom-cache data cannot terminate the long-lived collector.
                next.entry.copy(
                    projection = null,
                    loading = CalendarLoadingState(),
                    freshness = CalendarFreshness.ERROR,
                    error = CalendarExperienceError(CalendarExperienceErrorKind.CONTRACT, "Calendar data could not be displayed."),
                )
            }
            // Compute exact visible membership outside the lifecycle spin lock.
            // A whole-window filtered set would incorrectly admit nonvisible days.
            val visibleOccurrences = entry.projection?.visibleEvents.orEmpty().mapNotNull { event ->
                val identity = CalendarOccurrenceIdentity(event.eventId, event.occurrenceId,
                    event.originalStart ?: return@mapNotNull null, event.scope)
                winners[identity]?.let { identity to it }
            }.toMap()
            period to next.copy(entry = entry, occurrences = occurrences, visibleOccurrences = visibleOccurrences)
        }
        // Linearize publication with synchronous clear; old projections cannot
        // reinsert protected rows even when calculation raced namespace teardown.
        lock.withLock {
            if (publication == inputs.first && source == presentation.value.viewportPresentation() &&
                windows.values.all { current(it) }
            ) {
                published = inputs.first
                projected = prepared
                mutableState.value = CalendarViewportState(prepared.mapValues { it.value.entry })
            }
        }
    }

    private fun cacheError() = CalendarExperienceError(CalendarExperienceErrorKind.DATABASE, "Calendar cache is unavailable.")
}

private fun CalendarExperienceState.viewportPresentation() = CalendarViewportPresentation(locale, filters, selectedDate, todayDate)

/** Require a representable complete month grid for every locale week start, including later locale changes. */
private fun isViewportDate(date: String): Boolean {
    if (!isCalendarDate(date)) return false
    val monthStart = date.take(8) + "01"
    return isCalendarDate(addCalendarDays(monthStart, -6)) && isCalendarDate(addCalendarDays(monthStart, 42))
}

private fun EffectiveOccurrence.viewportIdentity() = CalendarOccurrenceIdentity(eventId, occurrenceId, originalStart, scope)

/** Bounded active-snapshot reconciliation, not a persisted or backend revision watermark. */
private fun viewportOccurrenceWinners(snapshots: List<CalendarCacheSnapshot>): Map<CalendarOccurrenceIdentity, EffectiveOccurrence> {
    val winners = linkedMapOf<CalendarOccurrenceIdentity, Pair<EffectiveOccurrence, CalendarCacheSnapshot>>()
    snapshots.forEach { snapshot ->
        snapshot.occurrences.forEach { occurrence ->
            val identity = occurrence.viewportIdentity()
            val prior = winners[identity]
            if (prior == null || occurrence.revision > prior.first.revision ||
                occurrence.revision == prior.first.revision && (
                    snapshot.fetchedAt > prior.second.fetchedAt ||
                        snapshot.fetchedAt == prior.second.fetchedAt && compareValuesBy(
                            snapshot.window, prior.second.window, { it.windowStart }, { it.windowEnd }, { it.timezoneInput },
                        ) > 0
                    )
            ) winners[identity] = occurrence to snapshot
        }
    }
    return winners.mapValues { it.value.first }
}
