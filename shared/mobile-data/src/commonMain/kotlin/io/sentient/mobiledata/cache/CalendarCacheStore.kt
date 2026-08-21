package io.sentient.mobiledata.cache

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.CalendarDatabaseHandle
import io.sentient.mobiledata.cache.db.Calendar_occurrence
import io.sentient.mobiledata.cache.db.SnapshotWithOccurrencesForWindow
import io.sentient.mobiledata.calendar.CalendarDates
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarPreferences
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobilesdk.calendar.CALENDAR_WIRE_TIME_ZONE
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.cancellation.CancellationException as KotlinCancellationException

/** The maximum number of complete windows retained for one namespace. */
const val CALENDAR_CACHE_MAX_RETAINED_WINDOWS: Int = 12

/** The authenticated account/backend key used by every cache operation. */
data class CalendarCacheNamespace(
    val accountId: String,
    val backendId: String,
) {
    init {
        require(accountId.isNotBlank())
        require(backendId.isNotBlank())
    }

    val account: String get() = accountId
    val backend: String get() = backendId
}

/** The complete date window used as a cache key. */
data class CalendarCacheWindow(
    val windowStart: String,
    val windowEnd: String,
    val timezoneInput: String = CALENDAR_WIRE_TIME_ZONE,
) {
    init {
        require(CalendarDates.isValid(windowStart))
        require(CalendarDates.isValid(windowEnd))
        require(windowStart < windowEnd)
        require(timezoneInput.isNotBlank())
    }

    val startDate: String get() = windowStart
    val endExclusive: String get() = windowEnd
    val timezone: String get() = timezoneInput
}

/** Cache metadata states persisted in the SQLDelight freshness column. */
enum class CalendarCacheFreshness(val wireValue: String) {
    FRESH("fresh"),
    STALE("stale"),
    REFRESHING("refreshing"),
    /** Legacy name retained for persisted callers; uncached offline uses the explicit state below. */
    OFFLINE("offline"),
    CACHED_OFFLINE("cached_offline"),
    UNAVAILABLE_OFFLINE("unavailable_offline"),
    ERROR("error"),
    ;

    val isUnavailableOffline: Boolean
        get() = this == OFFLINE || this == UNAVAILABLE_OFFLINE

    companion object {
        fun fromWire(value: String): CalendarCacheFreshness? = entries.firstOrNull { it.wireValue == value }
    }
}

typealias CalendarFreshness = CalendarCacheFreshness

/** One fully committed, unfiltered authorized window. */
data class CalendarCacheSnapshot(
    val window: CalendarCacheWindow,
    val occurrences: List<EffectiveOccurrence>,
    val fetchedAt: Long,
    val lastAccessedAt: Long = fetchedAt,
    val freshness: CalendarCacheFreshness = CalendarCacheFreshness.FRESH,
) {
    val events: List<EffectiveOccurrence> get() = occurrences
    val fetchedAtMillis: Long get() = fetchedAt
    val lastAccessedAtMillis: Long get() = lastAccessedAt
    val isComplete: Boolean get() = true
}

typealias CalendarMonthSnapshot = CalendarCacheSnapshot

/** Metadata for a committed window, without loading its occurrence payloads. */
data class CalendarCacheWindowMetadata(
    val window: CalendarCacheWindow,
    val fetchedAt: Long,
    val lastAccessedAt: Long,
    val freshness: CalendarCacheFreshness,
    val occurrenceCount: Int,
) {
    val fetchedAtMillis: Long get() = fetchedAt
    val lastAccessedAtMillis: Long get() = lastAccessedAt
}

/**
 * The supported, account/backend-scoped presentation preferences.  Device locale
 * and selected-date presentation state are intentionally not durable event/cache
 * data; the coordinator can derive them from [anchorDate] and its current locale.
 */
data class CalendarCachePreferences(
    val view: CalendarView = CalendarView.MONTH,
    val anchorDate: String,
    val scopes: List<CalendarScope> = listOf(CalendarScope.ALL),
    val groups: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val importance: Importance? = null,
    val searchText: String = "",
    val updatedAt: Long = 0L,
) {
    val search: String get() = searchText
    val query: String get() = searchText
    val selectedScopes: List<CalendarScope> get() = scopes

    fun toCalendarPreferences(): CalendarPreferences = CalendarPreferences(
        view = view,
        anchorDate = anchorDate,
        selectedDate = anchorDate,
        filters = CalendarFilters(
            scope = when {
                scopes.contains(CalendarScope.PRIVATE) && !scopes.contains(CalendarScope.HOUSEHOLD) -> CalendarScope.PRIVATE
                scopes.contains(CalendarScope.HOUSEHOLD) && !scopes.contains(CalendarScope.PRIVATE) -> CalendarScope.HOUSEHOLD
                else -> CalendarScope.ALL
            },
            groups = groups.toSet(),
            tags = tags.toSet(),
            importance = importance,
            text = searchText,
        ),
    )
}

typealias CalendarPreferencesSnapshot = CalendarCachePreferences

/** Sanitized, typed cache failures. No row, payload, event, or query text is retained. */
enum class CalendarCacheFailureReason {
    CLOSED,
    DATABASE,
    DECODE,
    INVALID_NAMESPACE,
    INVALID_WINDOW,
    INVALID_SNAPSHOT,
    INVALID_PREFERENCES,
    INVALID_RETENTION,
    NOT_FOUND,
}

data class CalendarCacheFailure(val reason: CalendarCacheFailureReason) {
    val kind: CalendarCacheFailureReason get() = reason
}

/** Typed result used by both one-shot reads and observable cache flows. */
sealed interface CalendarCacheResult<out T> {
    data class Success<T>(val value: T) : CalendarCacheResult<T> {
        val data: T get() = value
    }

    data class Failure(val error: CalendarCacheFailure) : CalendarCacheResult<Nothing> {
        val failure: CalendarCacheFailure get() = error
    }
}

typealias CalendarCacheReadResult<T> = CalendarCacheResult<T>
typealias CalendarCacheWriteResult = CalendarCacheResult<Unit>

/**
 * Domain-facing cache boundary. Generated SQLDelight row classes do not cross
 * this interface.
 */
interface CalendarCacheStore {
    val currentNamespace: StateFlow<CalendarCacheNamespace>
    val namespace: CalendarCacheNamespace
        get() = currentNamespace.value
    val isClosed: Boolean

    /**
     * Optional synchronous pre-switch hook for session coordinators. The SQLDelight
     * implementation invokes it before purging or selecting the successor so
     * visible state and in-flight work can be invalidated in the same call.
     */
    fun registerNamespaceChangeListener(listener: (CalendarCacheNamespace) -> Unit): () -> Unit = {}

    /** Emits one coherent result for the selected complete window per committed transaction. */
    fun observeSnapshot(window: CalendarCacheWindow): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>>

    fun snapshotFlow(window: CalendarCacheWindow): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> =
        observeSnapshot(window)

    suspend fun readSnapshot(window: CalendarCacheWindow): CalendarCacheReadResult<CalendarCacheSnapshot?>

    /** Replaces the complete window in one transaction; partial windows are never committed. */
    suspend fun replaceSnapshot(snapshot: CalendarCacheSnapshot): CalendarCacheWriteResult

    suspend fun replaceSnapshot(
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long = fetchedAt,
        freshness: CalendarCacheFreshness = CalendarCacheFreshness.FRESH,
    ): CalendarCacheWriteResult

    /**
     * Namespace-pinned replacement used by stale revalidation completions.
     * Implementations must reject the write atomically when the active
     * namespace has changed since the request started.
     */
    suspend fun replaceSnapshotForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long = fetchedAt,
        freshness: CalendarCacheFreshness = CalendarCacheFreshness.FRESH,
    ): CalendarCacheWriteResult {
        if (currentNamespace.value != namespace) return invalidNamespaceWriteFailure()
        return replaceSnapshot(window, occurrences, fetchedAt, lastAccessedAt, freshness)
    }

    /**
     * Replaces a complete window and evicts old complete windows as one cache
     * operation. SQLDelight implementations override this so replacement,
     * active-window protection, and retention share one transaction. The
     * default keeps lightweight test stores source-compatible while retaining
     * the same observable contract.
     */
    suspend fun replaceSnapshotAndRetainForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long = fetchedAt,
        freshness: CalendarCacheFreshness = CalendarCacheFreshness.FRESH,
        activeWindow: CalendarCacheWindow? = window,
        maxWindows: Int = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
    ): CalendarCacheWriteResult {
        val replacement = replaceSnapshotForNamespace(
            namespace = namespace,
            window = window,
            occurrences = occurrences,
            fetchedAt = fetchedAt,
            lastAccessedAt = lastAccessedAt,
            freshness = freshness,
        )
        if (replacement is CalendarCacheResult.Failure) return replacement
        return retainRecentWindowsForNamespace(namespace, activeWindow, maxWindows)
    }

    /** Retains the most recently accessed complete windows in the active namespace. */
    suspend fun retainRecentWindows(
        activeWindow: CalendarCacheWindow? = null,
        maxWindows: Int = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
    ): CalendarCacheWriteResult = if (maxWindows < 1) {
        invalidRetentionFailure()
    } else {
        CalendarCacheResult.Success(Unit)
    }

    /** Namespace-pinned retention operation used by stale background work. */
    suspend fun retainRecentWindowsForNamespace(
        namespace: CalendarCacheNamespace,
        activeWindow: CalendarCacheWindow? = null,
        maxWindows: Int = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
    ): CalendarCacheWriteResult {
        if (currentNamespace.value != namespace) return invalidNamespaceWriteFailure()
        return retainRecentWindows(activeWindow, maxWindows)
    }

    /** Compatibility name for callers that describe retention as eviction. */
    suspend fun evictLeastRecentlyViewed(
        activeWindow: CalendarCacheWindow? = null,
        maxWindows: Int = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
    ): CalendarCacheWriteResult = retainRecentWindows(activeWindow, maxWindows)

    /** Namespace-pinned access update used by the foreground observation. */
    suspend fun markAccessedForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
    ): CalendarCacheWriteResult {
        if (currentNamespace.value != namespace) return invalidNamespaceWriteFailure()
        return markAccessed(window, lastAccessedAt)
    }

    /** Touches the viewed window and evicts old windows atomically when supported. */
    suspend fun touchAndRetainForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
        maxWindows: Int = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
    ): CalendarCacheWriteResult {
        val touched = markAccessedForNamespace(namespace, window, lastAccessedAt)
        if (touched is CalendarCacheResult.Failure) return touched
        return retainRecentWindowsForNamespace(namespace, window, maxWindows)
    }

    fun observePreferences(): Flow<CalendarCacheReadResult<CalendarCachePreferences?>>

    fun preferencesFlow(): Flow<CalendarCacheReadResult<CalendarCachePreferences?>> = observePreferences()

    suspend fun readPreferences(): CalendarCacheReadResult<CalendarCachePreferences?>
    suspend fun writePreferences(preferences: CalendarCachePreferences): CalendarCacheWriteResult

    /** Namespace-pinned preference write; stale session completions are rejected. */
    suspend fun writePreferencesForNamespace(
        namespace: CalendarCacheNamespace,
        preferences: CalendarCachePreferences,
    ): CalendarCacheWriteResult {
        if (currentNamespace.value != namespace) return invalidNamespaceWriteFailure()
        return writePreferences(preferences)
    }

    suspend fun writePreferences(
        preferences: CalendarPreferences,
        updatedAt: Long = 0L,
    ): CalendarCacheWriteResult

    fun observeWindows(): Flow<CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>>
    suspend fun readWindows(): CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>

    suspend fun markAccessed(
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
    ): CalendarCacheWriteResult

    suspend fun markFreshness(
        window: CalendarCacheWindow,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult

    /** Namespace-pinned freshness metadata write; stale jobs cannot touch a successor. */
    suspend fun markFreshnessForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult {
        if (currentNamespace.value != namespace) return invalidNamespaceWriteFailure()
        return markFreshness(window, freshness)
    }

    suspend fun purgeNamespace(
        namespace: CalendarCacheNamespace = currentNamespace.value,
    ): CalendarCacheWriteResult

    /** Switches the active query namespace, optionally purging its predecessor first. */
    suspend fun switchNamespace(
        namespace: CalendarCacheNamespace,
        purgePrevious: Boolean = false,
    ): CalendarCacheWriteResult

    suspend fun purgeAndSwitch(namespace: CalendarCacheNamespace): CalendarCacheWriteResult =
        switchNamespace(namespace, purgePrevious = true)

    fun close()
}

private fun invalidNamespaceWriteFailure(): CalendarCacheWriteResult =
    CalendarCacheResult.Failure(
        CalendarCacheFailure(CalendarCacheFailureReason.INVALID_NAMESPACE),
    )

private fun invalidRetentionFailure(): CalendarCacheWriteResult =
    CalendarCacheResult.Failure(
        CalendarCacheFailure(CalendarCacheFailureReason.INVALID_RETENTION),
    )

/**
 * SQLDelight implementation of [CalendarCacheStore].  It owns the supplied
 * connection handle and closes it exactly once; platform code only supplies the
 * handle through [CalendarDatabaseHandle].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SqlDelightCalendarCacheStore private constructor(
    private val database: CalendarDatabase,
    initialNamespace: CalendarCacheNamespace,
    private val observationContext: CoroutineContext,
    private var closeAction: (() -> Unit)?,
) : CalendarCacheStore {
    constructor(
        handle: CalendarDatabaseHandle,
        initialNamespace: CalendarCacheNamespace,
        observationContext: CoroutineContext = Dispatchers.Default,
    ) : this(handle.database, initialNamespace, observationContext, handle::close)

    /** Test-only constructor that does not take ownership of a generated database. */
    internal constructor(
        database: CalendarDatabase,
        initialNamespace: CalendarCacheNamespace,
        observationContext: CoroutineContext = Dispatchers.Default,
    ) : this(database, initialNamespace, observationContext, null)

    private val queries = database.calendarDatabaseQueries
    private val writeMutex = Mutex()
    private val namespaceState = MutableStateFlow(initialNamespace)
    private val openState = MutableStateFlow(true)
    private var namespaceChangeListener: ((CalendarCacheNamespace) -> Unit)? = null
    private val json = Json {
        encodeDefaults = true
        explicitNulls = true
        ignoreUnknownKeys = false
        isLenient = false
    }

    override val currentNamespace: StateFlow<CalendarCacheNamespace> = namespaceState.asStateFlow()
    override val isClosed: Boolean get() = !openState.value

    override fun registerNamespaceChangeListener(listener: (CalendarCacheNamespace) -> Unit): () -> Unit {
        namespaceChangeListener = listener
        return {
            if (namespaceChangeListener === listener) namespaceChangeListener = null
        }
    }

    override fun observeSnapshot(window: CalendarCacheWindow): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> =
        selectedFlow { namespace -> observeSnapshotInNamespace(namespace, window) }

    override suspend fun readSnapshot(window: CalendarCacheWindow): CalendarCacheReadResult<CalendarCacheSnapshot?> =
        writeMutex.withLock {
            if (!openState.value) return@withLock closedFailure()
            try {
                readSnapshotInNamespace(namespaceState.value, window)
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                databaseFailure()
            }
        }

    override suspend fun replaceSnapshot(snapshot: CalendarCacheSnapshot): CalendarCacheWriteResult =
        replaceSnapshot(
            window = snapshot.window,
            occurrences = snapshot.occurrences,
            fetchedAt = snapshot.fetchedAt,
            lastAccessedAt = snapshot.lastAccessedAt,
            freshness = snapshot.freshness,
        )

    override suspend fun replaceSnapshot(
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        replaceSnapshotLocked(
            namespace = namespaceState.value,
            window = window,
            occurrences = occurrences,
            fetchedAt = fetchedAt,
            lastAccessedAt = lastAccessedAt,
            freshness = freshness,
            activeWindow = window,
            maxWindows = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
        )
    }

    override suspend fun replaceSnapshotForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        replaceSnapshotLocked(
            namespace = namespace,
            window = window,
            occurrences = occurrences,
            fetchedAt = fetchedAt,
            lastAccessedAt = lastAccessedAt,
            freshness = freshness,
            activeWindow = window,
            maxWindows = CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
        )
    }

    override suspend fun replaceSnapshotAndRetainForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long,
        freshness: CalendarCacheFreshness,
        activeWindow: CalendarCacheWindow?,
        maxWindows: Int,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        replaceSnapshotLocked(
            namespace = namespace,
            window = window,
            occurrences = occurrences,
            fetchedAt = fetchedAt,
            lastAccessedAt = lastAccessedAt,
            freshness = freshness,
            activeWindow = activeWindow,
            maxWindows = maxWindows,
        )
    }

    /** Called only while [writeMutex] is held, so namespace validation and the
     * complete transaction share one linearization point. */
    private fun replaceSnapshotLocked(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
        lastAccessedAt: Long,
        freshness: CalendarCacheFreshness,
        activeWindow: CalendarCacheWindow?,
        maxWindows: Int,
    ): CalendarCacheWriteResult {
        if (maxWindows < 1) return invalidRetentionFailure()
        val encoded = try {
            val serialized = encodeOccurrences(occurrences)
            require(fetchedAt >= 0L)
            require(lastAccessedAt >= 0L)
            serialized
        } catch (_: InvalidSnapshotException) {
            return invalidSnapshotFailure()
        } catch (_: IllegalArgumentException) {
            return invalidSnapshotFailure()
        } catch (_: SerializationException) {
            return invalidSnapshotFailure()
        }

        return try {
            database.transaction {
                // Remove the previous complete window and stage a new, incomplete
                // marker. The marker is flipped only after every row is inserted.
                // SQLite rollback restores the previous window if any statement
                // fails, while query observers are notified only at commit.
                queries.deleteOccurrencesForWindow(
                    namespace.accountId,
                    namespace.backendId,
                    window.windowStart,
                    window.windowEnd,
                    window.timezoneInput,
                )
                queries.deleteSnapshot(
                    namespace.accountId,
                    namespace.backendId,
                    window.windowStart,
                    window.windowEnd,
                    window.timezoneInput,
                )
                queries.insertSnapshot(
                    account_id = namespace.accountId,
                    backend_id = namespace.backendId,
                    window_start = window.windowStart,
                    window_end = window.windowEnd,
                    timezone_input = window.timezoneInput,
                    is_complete = false,
                    fetched_at = fetchedAt,
                    last_accessed_at = lastAccessedAt,
                    freshness = freshness.wireValue,
                    occurrence_count = encoded.size.toLong(),
                )
                encoded.forEach { occurrence ->
                    queries.insertOccurrence(
                        account_id = namespace.accountId,
                        backend_id = namespace.backendId,
                        window_start = window.windowStart,
                        window_end = window.windowEnd,
                        timezone_input = window.timezoneInput,
                        occurrence_id = occurrence.occurrence.occurrenceId,
                        event_id = occurrence.occurrence.eventId,
                        original_start = occurrence.occurrence.originalStart,
                        original_start_is_all_day = occurrence.originalStartIsAllDay,
                        start_value = occurrence.occurrence.start,
                        start_is_all_day = occurrence.startIsAllDay,
                        end_value = occurrence.occurrence.end,
                        end_is_all_day = occurrence.endIsAllDay,
                        recurring = occurrence.occurrence.recurring,
                        revision = occurrence.occurrence.revision.toLong(),
                        scope = scopeWire(occurrence.occurrence.scope),
                        visibility = visibilityWire(occurrence.occurrence.visibility),
                        title = occurrence.occurrence.title,
                        description = occurrence.occurrence.description,
                        importance = importanceWire(occurrence.occurrence.importance),
                        group_name = occurrence.occurrence.group,
                        tags_json = occurrence.tagsJson,
                        recurrence_json = occurrence.recurrenceJson,
                        payload_json = occurrence.payloadJson,
                    )
                }
                queries.updateSnapshotMetadata(
                    is_complete = true,
                    fetched_at = fetchedAt,
                    last_accessed_at = lastAccessedAt,
                    freshness = freshness.wireValue,
                    occurrence_count = encoded.size.toLong(),
                    account_id = namespace.accountId,
                    backend_id = namespace.backendId,
                    window_start = window.windowStart,
                    window_end = window.windowEnd,
                    timezone_input = window.timezoneInput,
                )
                evictLeastRecentlyViewedLocked(namespace, activeWindow, maxWindows)
            }
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override suspend fun retainRecentWindows(
        activeWindow: CalendarCacheWindow?,
        maxWindows: Int,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (maxWindows < 1) return@withLock invalidRetentionFailure()
        try {
            database.transaction {
                evictLeastRecentlyViewedLocked(namespaceState.value, activeWindow, maxWindows)
            }
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override suspend fun retainRecentWindowsForNamespace(
        namespace: CalendarCacheNamespace,
        activeWindow: CalendarCacheWindow?,
        maxWindows: Int,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        if (maxWindows < 1) return@withLock invalidRetentionFailure()
        try {
            database.transaction {
                evictLeastRecentlyViewedLocked(namespace, activeWindow, maxWindows)
            }
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override suspend fun markAccessedForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        markAccessedLocked(namespace, window, lastAccessedAt)
    }

    override suspend fun touchAndRetainForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
        maxWindows: Int,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        if (maxWindows < 1 || lastAccessedAt < 0L) {
            return@withLock if (maxWindows < 1) invalidRetentionFailure() else invalidSnapshotFailure()
        }
        try {
            database.transaction {
                val affected = queries.touchSnapshot(
                    last_accessed_at = lastAccessedAt,
                    account_id = namespace.accountId,
                    backend_id = namespace.backendId,
                    window_start = window.windowStart,
                    window_end = window.windowEnd,
                    timezone_input = window.timezoneInput,
                ).value
                if (affected == 0L) throw SnapshotNotFoundException()
                evictLeastRecentlyViewedLocked(namespace, window, maxWindows)
            }
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: SnapshotNotFoundException) {
            notFoundFailure()
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    /** Called while a write transaction is held. The query is ordered by LRU
     * metadata, so tie-breaking remains deterministic across drivers. */
    private fun evictLeastRecentlyViewedLocked(
        namespace: CalendarCacheNamespace,
        activeWindow: CalendarCacheWindow?,
        maxWindows: Int,
    ) {
        require(maxWindows >= 1)
        val complete = queries.allSnapshotsForNamespace(
            namespace.accountId,
            namespace.backendId,
        ).executeAsList()
            .filter { it.is_complete }
            .sortedWith(
                compareBy<io.sentient.mobiledata.cache.db.Calendar_month_snapshot> { it.last_accessed_at }
                    .thenBy { it.window_start }
                    .thenBy { it.window_end }
                    .thenBy { it.timezone_input },
            )
        val excess = complete.size - maxWindows
        if (excess <= 0) return
        val candidates = complete.filterNot { row ->
            activeWindow != null &&
                row.window_start == activeWindow.windowStart &&
                row.window_end == activeWindow.windowEnd &&
                row.timezone_input == activeWindow.timezoneInput
        }
        candidates.take(excess).forEach { row ->
            queries.deleteOccurrencesForWindow(
                row.account_id,
                row.backend_id,
                row.window_start,
                row.window_end,
                row.timezone_input,
            )
            queries.deleteSnapshot(
                row.account_id,
                row.backend_id,
                row.window_start,
                row.window_end,
                row.timezone_input,
            )
        }
    }

    override fun observePreferences(): Flow<CalendarCacheReadResult<CalendarCachePreferences?>> =
        selectedFlow { namespace -> observePreferencesInNamespace(namespace) }

    override suspend fun readPreferences(): CalendarCacheReadResult<CalendarCachePreferences?> =
        writeMutex.withLock {
            if (!openState.value) return@withLock closedFailure()
            try {
                decodePreferences(
                    namespaceState.value,
                    queries.preferencesForNamespace(
                        namespaceState.value.accountId,
                        namespaceState.value.backendId,
                    ).executeAsList(),
                )
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                databaseFailure()
            }
        }

    override suspend fun writePreferences(preferences: CalendarCachePreferences): CalendarCacheWriteResult =
        writeMutex.withLock {
            if (!openState.value) return@withLock closedFailure()
            writePreferencesLocked(namespaceState.value, preferences)
        }

    override suspend fun writePreferencesForNamespace(
        namespace: CalendarCacheNamespace,
        preferences: CalendarCachePreferences,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        writePreferencesLocked(namespace, preferences)
    }

    /** Called only while [writeMutex] is held. */
    private fun writePreferencesLocked(
        namespace: CalendarCacheNamespace,
        preferences: CalendarCachePreferences,
    ): CalendarCacheWriteResult {
        val normalized = try {
            normalizePreferences(preferences)
        } catch (_: InvalidPreferencesException) {
            return invalidPreferencesFailure()
        } catch (_: IllegalArgumentException) {
            return invalidPreferencesFailure()
        }
        return try {
            queries.upsertPreferences(
                account_id = namespace.accountId,
                backend_id = namespace.backendId,
                view_mode = viewWire(normalized.view),
                anchor_date = normalized.anchorDate,
                scopes_json = encodeList(ListSerializer(CalendarScope.serializer()), normalized.scopes),
                groups_json = encodeList(ListSerializer(String.serializer()), normalized.groups),
                tags_json = encodeList(ListSerializer(String.serializer()), normalized.tags),
                importance_json = encodeList(
                    ListSerializer(Importance.serializer()),
                    normalized.importance?.let(::listOf).orEmpty(),
                ),
                search_text = normalized.searchText,
                updated_at = normalized.updatedAt,
            )
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override suspend fun writePreferences(
        preferences: CalendarPreferences,
        updatedAt: Long,
    ): CalendarCacheWriteResult = writePreferences(preferences.toCachePreferences(updatedAt))

    override fun observeWindows(): Flow<CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>> =
        selectedFlow { namespace -> observeWindowsInNamespace(namespace) }

    override suspend fun readWindows(): CalendarCacheReadResult<List<CalendarCacheWindowMetadata>> =
        writeMutex.withLock {
            if (!openState.value) return@withLock closedFailure()
            try {
                decodeWindows(
                    namespaceState.value,
                    queries.allSnapshotsForNamespace(
                        namespaceState.value.accountId,
                        namespaceState.value.backendId,
                    ).executeAsList(),
                )
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                databaseFailure()
            }
        }

    override suspend fun markAccessed(
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        markAccessedLocked(namespaceState.value, window, lastAccessedAt)
    }

    /** Called only while [writeMutex] is held. */
    private fun markAccessedLocked(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        lastAccessedAt: Long,
    ): CalendarCacheWriteResult {
        if (lastAccessedAt < 0L) return invalidSnapshotFailure()
        return try {
            val affected = queries.touchSnapshot(
                last_accessed_at = lastAccessedAt,
                account_id = namespace.accountId,
                backend_id = namespace.backendId,
                window_start = window.windowStart,
                window_end = window.windowEnd,
                timezone_input = window.timezoneInput,
            ).value
            if (affected == 0L) notFoundFailure() else CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override suspend fun markFreshness(
        window: CalendarCacheWindow,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        markFreshnessLocked(namespaceState.value, window, freshness)
    }

    override suspend fun markFreshnessForNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        if (namespace != namespaceState.value) return@withLock invalidNamespaceWriteFailure()
        markFreshnessLocked(namespace, window, freshness)
    }

    /** Called only while [writeMutex] is held. */
    private fun markFreshnessLocked(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        freshness: CalendarCacheFreshness,
    ): CalendarCacheWriteResult = try {
        val affected = queries.setSnapshotFreshness(
            freshness = freshness.wireValue,
            account_id = namespace.accountId,
            backend_id = namespace.backendId,
            window_start = window.windowStart,
            window_end = window.windowEnd,
            timezone_input = window.timezoneInput,
        ).value
        if (affected == 0L) notFoundFailure() else CalendarCacheResult.Success(Unit)
    } catch (cancelled: KotlinCancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        databaseFailure()
    }

    override suspend fun purgeNamespace(namespace: CalendarCacheNamespace): CalendarCacheWriteResult =
        writeMutex.withLock {
            if (!openState.value) return@withLock closedFailure()
            try {
                database.transaction { purgeNamespaceRows(namespace) }
                CalendarCacheResult.Success(Unit)
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                databaseFailure()
            }
        }

    override suspend fun switchNamespace(
        namespace: CalendarCacheNamespace,
        purgePrevious: Boolean,
    ): CalendarCacheWriteResult = writeMutex.withLock {
        if (!openState.value) return@withLock closedFailure()
        val previous = namespaceState.value
        try {
            if (previous != namespace) {
                // Invalidate session-owned visible state before any predecessor
                // purge or successor query can complete.
                namespaceChangeListener?.invoke(namespace)
            }
            if (purgePrevious) {
                database.transaction { purgeNamespaceRows(previous) }
            }
            namespaceState.value = namespace
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
        }
    }

    override fun close() {
        if (!openState.value) return
        // Stop query collectors before closing the driver. A successor namespace
        // can therefore never receive a queued result from this store instance.
        openState.value = false
        namespaceChangeListener = null
        val action = closeAction
        closeAction = null
        action?.invoke()
    }

    private fun <T> selectedFlow(
        query: (CalendarCacheNamespace) -> Flow<CalendarCacheReadResult<T>>,
    ): Flow<CalendarCacheReadResult<T>> = combine(
        openState,
        namespaceState,
    ) { open, namespace -> StoreSelection(open, namespace) }
        .flatMapLatest { selection ->
            if (!selection.open) flowOf(closedFailure()) else query(selection.namespace)
        }

    private fun observeSnapshotInNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
    ): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> = queries.snapshotWithOccurrencesForWindow(
        namespace.accountId,
        namespace.backendId,
        window.windowStart,
        window.windowEnd,
        window.timezoneInput,
    ).asFlow()
        .mapToList(observationContext)
        .map { rows -> decodeSnapshot(namespace, window, rows) }
        .catch { failure ->
            if (failure is CancellationException) throw failure
            emit(if (!openState.value) closedFailure() else databaseFailure())
        }

    private fun observePreferencesInNamespace(
        namespace: CalendarCacheNamespace,
    ): Flow<CalendarCacheReadResult<CalendarCachePreferences?>> = queries.preferencesForNamespace(
        namespace.accountId,
        namespace.backendId,
    ).asFlow()
        .mapToList(observationContext)
        .map { rows -> decodePreferences(namespace, rows) }
        .catch { failure ->
            if (failure is CancellationException) throw failure
            emit(if (!openState.value) closedFailure() else databaseFailure())
        }

    private fun observeWindowsInNamespace(
        namespace: CalendarCacheNamespace,
    ): Flow<CalendarCacheReadResult<List<CalendarCacheWindowMetadata>>> = queries.allSnapshotsForNamespace(
        namespace.accountId,
        namespace.backendId,
    ).asFlow()
        .mapToList(observationContext)
        .map { rows -> decodeWindows(namespace, rows) }
        .catch { failure ->
            if (failure is CancellationException) throw failure
            emit(if (!openState.value) closedFailure() else databaseFailure())
        }

    private fun readSnapshotInNamespace(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
    ): CalendarCacheReadResult<CalendarCacheSnapshot?> = decodeSnapshot(
        namespace,
        window,
        queries.snapshotWithOccurrencesForWindow(
            namespace.accountId,
            namespace.backendId,
            window.windowStart,
            window.windowEnd,
            window.timezoneInput,
        ).executeAsList(),
    )

    /**
     * Decode one SQLDelight query result.  Metadata is repeated on each joined
     * occurrence row, so a single query execution is the generation boundary
     * for both parts of the observable snapshot.  An empty complete snapshot
     * has one LEFT JOIN row with null occurrence columns.
     */
    private fun decodeSnapshot(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        rows: List<SnapshotWithOccurrencesForWindow>,
    ): CalendarCacheReadResult<CalendarCacheSnapshot?> {
        return try {
            val metadata = rows.firstOrNull() ?: return CalendarCacheResult.Success(null)
            if (rows.any { !sameSnapshotMetadata(it, metadata) }) corrupt()
            if (!metadata.snapshot_is_complete) return CalendarCacheResult.Success(null)
            validateSnapshotMetadata(namespace, window, metadata)
            if (metadata.snapshot_occurrence_count < 0L || metadata.snapshot_occurrence_count > Int.MAX_VALUE) corrupt()
            val occurrenceRows = rows.mapNotNull(::occurrenceRow)
            if (metadata.snapshot_occurrence_count != occurrenceRows.size.toLong()) corrupt()
            val occurrences = occurrenceRows.map(::decodeOccurrence)
            CalendarCacheResult.Success(
                CalendarCacheSnapshot(
                    window = window,
                    occurrences = occurrences,
                    fetchedAt = metadata.snapshot_fetched_at,
                    lastAccessedAt = metadata.snapshot_last_accessed_at,
                    freshness = CalendarCacheFreshness.fromWire(metadata.snapshot_freshness) ?: corrupt(),
                ),
            )
        } catch (_: DecodeFailure) {
            decodeFailure()
        } catch (_: SerializationException) {
            decodeFailure()
        } catch (_: IllegalArgumentException) {
            decodeFailure()
        }
    }

    private fun sameSnapshotMetadata(
        first: SnapshotWithOccurrencesForWindow,
        other: SnapshotWithOccurrencesForWindow,
    ): Boolean = first.snapshot_account_id == other.snapshot_account_id &&
        first.snapshot_backend_id == other.snapshot_backend_id &&
        first.snapshot_window_start == other.snapshot_window_start &&
        first.snapshot_window_end == other.snapshot_window_end &&
        first.snapshot_timezone_input == other.snapshot_timezone_input &&
        first.snapshot_is_complete == other.snapshot_is_complete &&
        first.snapshot_fetched_at == other.snapshot_fetched_at &&
        first.snapshot_occurrence_count == other.snapshot_occurrence_count &&
        first.snapshot_last_accessed_at == other.snapshot_last_accessed_at &&
        first.snapshot_freshness == other.snapshot_freshness

    private fun occurrenceRow(row: SnapshotWithOccurrencesForWindow): Calendar_occurrence? {
        if (row.occurrence_account_id == null) {
            if (
                row.occurrence_backend_id != null ||
                row.occurrence_window_start != null ||
                row.occurrence_window_end != null ||
                row.occurrence_timezone_input != null ||
                row.occurrence_id != null ||
                row.event_id != null ||
                row.original_start != null ||
                row.original_start_is_all_day != null ||
                row.start_value != null ||
                row.start_is_all_day != null ||
                row.end_value != null ||
                row.end_is_all_day != null ||
                row.recurring != null ||
                row.revision != null ||
                row.scope != null ||
                row.visibility != null ||
                row.title != null ||
                row.description != null ||
                row.importance != null ||
                row.group_name != null ||
                row.tags_json != null ||
                row.recurrence_json != null ||
                row.payload_json != null
            ) corrupt()
            return null
        }
        return Calendar_occurrence(
            account_id = row.occurrence_account_id,
            backend_id = row.occurrence_backend_id ?: corrupt(),
            window_start = row.occurrence_window_start ?: corrupt(),
            window_end = row.occurrence_window_end ?: corrupt(),
            timezone_input = row.occurrence_timezone_input ?: corrupt(),
            occurrence_id = row.occurrence_id ?: corrupt(),
            event_id = row.event_id ?: corrupt(),
            original_start = row.original_start ?: corrupt(),
            original_start_is_all_day = row.original_start_is_all_day ?: corrupt(),
            start_value = row.start_value ?: corrupt(),
            start_is_all_day = row.start_is_all_day ?: corrupt(),
            end_value = row.end_value,
            end_is_all_day = row.end_is_all_day,
            recurring = row.recurring ?: corrupt(),
            revision = row.revision ?: corrupt(),
            scope = row.scope ?: corrupt(),
            visibility = row.visibility ?: corrupt(),
            title = row.title ?: corrupt(),
            description = row.description,
            importance = row.importance ?: corrupt(),
            group_name = row.group_name,
            tags_json = row.tags_json ?: corrupt(),
            recurrence_json = row.recurrence_json,
            payload_json = row.payload_json ?: corrupt(),
        )
    }

    private fun decodePreferences(
        namespace: CalendarCacheNamespace,
        rows: List<io.sentient.mobiledata.cache.db.Calendar_preferences>,
    ): CalendarCacheReadResult<CalendarCachePreferences?> = try {
        val row = rows.singleOrNull() ?: return CalendarCacheResult.Success(null)
        if (row.account_id != namespace.accountId || row.backend_id != namespace.backendId) corrupt()
        if (row.updated_at < 0L) corrupt()
        val scopes = decodeList(ListSerializer(CalendarScope.serializer()), row.scopes_json)
        val groups = decodeList(ListSerializer(String.serializer()), row.groups_json)
        val tags = decodeList(ListSerializer(String.serializer()), row.tags_json)
        val importanceValues = decodeList(ListSerializer(Importance.serializer()), row.importance_json)
        if (importanceValues.size > 1) corrupt()
        val preferences = CalendarCachePreferences(
            view = viewFromWire(row.view_mode) ?: corrupt(),
            anchorDate = row.anchor_date,
            scopes = scopes,
            groups = groups,
            tags = tags,
            importance = importanceValues.singleOrNull(),
            searchText = row.search_text,
            updatedAt = row.updated_at,
        )
        CalendarCacheResult.Success(normalizePreferences(preferences))
    } catch (_: DecodeFailure) {
        decodeFailure()
    } catch (_: SerializationException) {
        decodeFailure()
    } catch (_: InvalidPreferencesException) {
        decodeFailure()
    } catch (_: IllegalArgumentException) {
        decodeFailure()
    }

    private fun decodeWindows(
        namespace: CalendarCacheNamespace,
        rows: List<io.sentient.mobiledata.cache.db.Calendar_month_snapshot>,
    ): CalendarCacheReadResult<List<CalendarCacheWindowMetadata>> = try {
        val result = rows.map { row ->
            if (row.account_id != namespace.accountId || row.backend_id != namespace.backendId) corrupt()
            if (!row.is_complete) return@map null
            if (
                row.occurrence_count < 0L ||
                row.occurrence_count > Int.MAX_VALUE ||
                row.fetched_at < 0L ||
                row.last_accessed_at < 0L
            ) corrupt()
            val window = CalendarCacheWindow(row.window_start, row.window_end, row.timezone_input)
            CalendarCacheWindowMetadata(
                window = window,
                fetchedAt = row.fetched_at,
                lastAccessedAt = row.last_accessed_at,
                freshness = CalendarCacheFreshness.fromWire(row.freshness) ?: corrupt(),
                occurrenceCount = row.occurrence_count.toInt(),
            )
        }.filterNotNull()
        CalendarCacheResult.Success(result)
    } catch (_: DecodeFailure) {
        decodeFailure()
    } catch (_: IllegalArgumentException) {
        decodeFailure()
    }

    private fun validateSnapshotMetadata(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        row: SnapshotWithOccurrencesForWindow,
    ) {
        if (
            row.snapshot_account_id != namespace.accountId ||
            row.snapshot_backend_id != namespace.backendId ||
            row.snapshot_window_start != window.windowStart ||
            row.snapshot_window_end != window.windowEnd ||
            row.snapshot_timezone_input != window.timezoneInput ||
            row.snapshot_fetched_at < 0L ||
            row.snapshot_last_accessed_at < 0L ||
            CalendarCacheFreshness.fromWire(row.snapshot_freshness) == null
        ) corrupt()
    }

    private fun decodeOccurrence(
        row: io.sentient.mobiledata.cache.db.Calendar_occurrence,
    ): EffectiveOccurrence {
        if (row.occurrence_id.isBlank() || row.event_id.isBlank()) corrupt()
        val occurrence = json.decodeFromString(EffectiveOccurrence.serializer(), row.payload_json)
        if (
            row.payload_json != encodeString(EffectiveOccurrence.serializer(), occurrence) ||
            row.occurrence_id != occurrence.occurrenceId ||
            row.event_id != occurrence.eventId ||
            row.original_start != occurrence.originalStart ||
            row.start_value != occurrence.start ||
            row.end_value != occurrence.end ||
            row.recurring != occurrence.recurring ||
            row.revision != occurrence.revision.toLong() ||
            row.scope != scopeWire(occurrence.scope) ||
            row.visibility != visibilityWire(occurrence.visibility) ||
            row.title != occurrence.title ||
            row.description != occurrence.description ||
            row.importance != importanceWire(occurrence.importance) ||
            row.group_name != occurrence.group ||
            row.tags_json != encodeList(ListSerializer(String.serializer()), occurrence.tags) ||
            row.recurrence_json != occurrence.recurrence?.let { encodeString(StructuredRecurrence.serializer(), it) }
        ) corrupt()
        if (row.original_start_is_all_day != isAllDay(occurrence.originalStart)) corrupt()
        if (row.start_is_all_day != isAllDay(occurrence.start)) corrupt()
        if (row.end_is_all_day != occurrence.end?.let(::isAllDay)) corrupt()
        return occurrence
    }

    private fun encodeOccurrences(occurrences: List<EffectiveOccurrence>): List<EncodedOccurrence> {
        val ids = HashSet<String>(occurrences.size)
        return occurrences.map { occurrence ->
            if (
                occurrence.eventId.isBlank() ||
                occurrence.occurrenceId.isBlank() ||
                occurrence.originalStart.isBlank() ||
                occurrence.start.isBlank() ||
                occurrence.end == ""
            ) throw InvalidSnapshotException()
            if (!ids.add(occurrence.occurrenceId)) throw InvalidSnapshotException()
            EncodedOccurrence(
                occurrence = occurrence,
                originalStartIsAllDay = isAllDay(occurrence.originalStart),
                startIsAllDay = isAllDay(occurrence.start),
                endIsAllDay = occurrence.end?.let(::isAllDay),
                tagsJson = encodeList(ListSerializer(String.serializer()), occurrence.tags),
                recurrenceJson = occurrence.recurrence?.let { encodeString(StructuredRecurrence.serializer(), it) },
                payloadJson = encodeString(EffectiveOccurrence.serializer(), occurrence),
            )
        }
    }

    private fun normalizePreferences(preferences: CalendarCachePreferences): CalendarCachePreferences {
        if (!CalendarDates.isValid(preferences.anchorDate) || preferences.updatedAt < 0L) {
            throw InvalidPreferencesException()
        }
        val scopes = preferences.scopes.distinct()
        if (scopes.isEmpty()) throw InvalidPreferencesException()
        val canonicalScopes = if (scopes.contains(CalendarScope.ALL)) {
            listOf(CalendarScope.ALL)
        } else {
            scopes.sortedBy { it.ordinal }
        }
        val groups = canonicalFilterValues(preferences.groups)
        val tags = canonicalFilterValues(preferences.tags)
        if (preferences.searchText.length > MAX_SEARCH_LENGTH) throw InvalidPreferencesException()
        return preferences.copy(
            scopes = canonicalScopes,
            groups = groups,
            tags = tags,
        )
    }

    private fun canonicalFilterValues(values: List<String>): List<String> {
        if (values.size > MAX_FILTER_VALUES) throw InvalidPreferencesException()
        if (values.any { it.isBlank() || it.length > MAX_FILTER_VALUE_LENGTH }) {
            throw InvalidPreferencesException()
        }
        return values.distinct().sorted()
    }

    private fun purgeNamespaceRows(namespace: CalendarCacheNamespace) {
        queries.deleteOccurrencesForNamespace(namespace.accountId, namespace.backendId)
        queries.deleteSnapshotsForNamespace(namespace.accountId, namespace.backendId)
        queries.deletePreferencesForNamespace(namespace.accountId, namespace.backendId)
    }

    override fun toString(): String = "SqlDelightCalendarCacheStore(open=${openState.value})"

    private data class StoreSelection(
        val open: Boolean,
        val namespace: CalendarCacheNamespace,
    )

    private data class EncodedOccurrence(
        val occurrence: EffectiveOccurrence,
        val originalStartIsAllDay: Boolean,
        val startIsAllDay: Boolean,
        val endIsAllDay: Boolean?,
        val tagsJson: String,
        val recurrenceJson: String?,
        val payloadJson: String,
    )

    private class InvalidSnapshotException : Exception()
    private class InvalidPreferencesException : Exception()
    private class SnapshotNotFoundException : Exception()
    private class DecodeFailure : Exception()

    private fun corrupt(): Nothing = throw DecodeFailure()

    private fun isAllDay(value: String): Boolean = CalendarDates.isValid(value)

    private fun <T> encodeString(serializer: kotlinx.serialization.KSerializer<T>, value: T): String =
        json.encodeToString(serializer, value)

    private fun <T> encodeList(serializer: kotlinx.serialization.KSerializer<List<T>>, value: List<T>): String =
        json.encodeToString(serializer, value)

    private fun <T> decodeList(serializer: kotlinx.serialization.KSerializer<List<T>>, value: String): List<T> =
        json.decodeFromString(serializer, value)

    private fun closedFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.CLOSED))

    private fun databaseFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.DATABASE))

    private fun decodeFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.DECODE))

    private fun invalidSnapshotFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.INVALID_SNAPSHOT))

    private fun invalidPreferencesFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.INVALID_PREFERENCES))

    private fun notFoundFailure(): CalendarCacheResult.Failure =
        CalendarCacheResult.Failure(CalendarCacheFailure(CalendarCacheFailureReason.NOT_FOUND))

    private companion object {
        const val MAX_FILTER_VALUE_LENGTH = 256
        const val MAX_FILTER_VALUES = 128
        const val MAX_SEARCH_LENGTH = 512
    }
}

/** Build a store without exposing generated SQLDelight types to callers. */
fun createCalendarCacheStore(
    handle: CalendarDatabaseHandle,
    namespace: CalendarCacheNamespace,
    observationContext: CoroutineContext = Dispatchers.Default,
): CalendarCacheStore = SqlDelightCalendarCacheStore(handle, namespace, observationContext)

fun createCalendarCacheStore(
    handle: CalendarDatabaseHandle,
    accountId: String,
    backendId: String,
    observationContext: CoroutineContext = Dispatchers.Default,
): CalendarCacheStore = createCalendarCacheStore(
    handle = handle,
    namespace = CalendarCacheNamespace(accountId.trim(), backendId.trim()),
    observationContext = observationContext,
)

private fun CalendarPreferences.toCachePreferences(updatedAt: Long): CalendarCachePreferences {
    val scopes = when (filters.scope) {
        CalendarScope.PRIVATE -> listOf(CalendarScope.PRIVATE)
        CalendarScope.HOUSEHOLD -> listOf(CalendarScope.HOUSEHOLD)
        CalendarScope.ALL -> listOf(CalendarScope.ALL)
    }
    return CalendarCachePreferences(
        view = view,
        anchorDate = anchorDate,
        scopes = scopes,
        groups = filters.groups.toList(),
        tags = filters.tags.toList(),
        importance = filters.importance,
        searchText = filters.text,
        updatedAt = updatedAt,
    )
}

private fun viewWire(value: CalendarView): String = when (value) {
    CalendarView.DAY -> "day"
    CalendarView.WEEK -> "week"
    CalendarView.MONTH -> "month"
    CalendarView.YEAR -> "year"
}

private fun viewFromWire(value: String): CalendarView? = when (value) {
    "day" -> CalendarView.DAY
    "week" -> CalendarView.WEEK
    "month" -> CalendarView.MONTH
    "year" -> CalendarView.YEAR
    else -> null
}

private fun scopeWire(value: CalendarScope): String = when (value) {
    CalendarScope.PRIVATE -> "private"
    CalendarScope.HOUSEHOLD -> "household"
    CalendarScope.ALL -> "all"
}

private fun visibilityWire(value: Visibility): String = when (value) {
    Visibility.EVERYONE -> "everyone"
    Visibility.ADULTS -> "adults"
}

private fun importanceWire(value: Importance): String = when (value) {
    Importance.NORMAL -> "normal"
    Importance.IMPORTANT -> "important"
    Importance.PINNED -> "pinned"
}
