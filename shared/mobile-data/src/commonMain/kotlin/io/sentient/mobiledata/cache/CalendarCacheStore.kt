package io.sentient.mobiledata.cache

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import io.sentient.mobiledata.cache.db.CalendarDatabase
import io.sentient.mobiledata.cache.db.CalendarDatabaseHandle
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
    OFFLINE("offline"),
    CACHED_OFFLINE("cached_offline"),
    ERROR("error"),
    ;

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

    fun observePreferences(): Flow<CalendarCacheReadResult<CalendarCachePreferences?>>

    fun preferencesFlow(): Flow<CalendarCacheReadResult<CalendarCachePreferences?>> = observePreferences()

    suspend fun readPreferences(): CalendarCacheReadResult<CalendarCachePreferences?>
    suspend fun writePreferences(preferences: CalendarCachePreferences): CalendarCacheWriteResult

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
    private val json = Json {
        encodeDefaults = true
        explicitNulls = true
        ignoreUnknownKeys = false
        isLenient = false
    }

    override val currentNamespace: StateFlow<CalendarCacheNamespace> = namespaceState.asStateFlow()
    override val isClosed: Boolean get() = !openState.value

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

        val encoded = try {
            val serialized = encodeOccurrences(occurrences)
            require(fetchedAt >= 0L)
            require(lastAccessedAt >= 0L)
            serialized
        } catch (_: InvalidSnapshotException) {
            return@withLock invalidSnapshotFailure()
        } catch (_: IllegalArgumentException) {
            return@withLock invalidSnapshotFailure()
        } catch (_: SerializationException) {
            return@withLock invalidSnapshotFailure()
        }

        try {
            val namespace = namespaceState.value
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
            }
            CalendarCacheResult.Success(Unit)
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            databaseFailure()
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
            val normalized = try {
                normalizePreferences(preferences)
            } catch (_: InvalidPreferencesException) {
                return@withLock invalidPreferencesFailure()
            } catch (_: IllegalArgumentException) {
                return@withLock invalidPreferencesFailure()
            }
            try {
                val namespace = namespaceState.value
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
        if (lastAccessedAt < 0L) return@withLock invalidSnapshotFailure()
        try {
            val namespace = namespaceState.value
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
        try {
            val namespace = namespaceState.value
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
    ): Flow<CalendarCacheReadResult<CalendarCacheSnapshot?>> = queries.occurrencesForWindow(
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
    ): CalendarCacheReadResult<CalendarCacheSnapshot?> {
        val rows = queries.occurrencesForWindow(
            namespace.accountId,
            namespace.backendId,
            window.windowStart,
            window.windowEnd,
            window.timezoneInput,
        ).executeAsList()
        return decodeSnapshot(namespace, window, rows)
    }

    private fun decodeSnapshot(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        rows: List<io.sentient.mobiledata.cache.db.Calendar_occurrence>,
    ): CalendarCacheReadResult<CalendarCacheSnapshot?> {
        return try {
            val metadata = queries.snapshotForWindow(
                namespace.accountId,
                namespace.backendId,
                window.windowStart,
                window.windowEnd,
                window.timezoneInput,
            ).executeAsList().singleOrNull()
                ?: return CalendarCacheResult.Success(null)
            if (!metadata.is_complete) return CalendarCacheResult.Success(null)
            validateSnapshotMetadata(namespace, window, metadata)
            if (metadata.occurrence_count < 0L || metadata.occurrence_count > Int.MAX_VALUE) corrupt()
            if (metadata.occurrence_count != rows.size.toLong()) corrupt()
            val occurrences = rows.map(::decodeOccurrence)
            CalendarCacheResult.Success(
                CalendarCacheSnapshot(
                    window = window,
                    occurrences = occurrences,
                    fetchedAt = metadata.fetched_at,
                    lastAccessedAt = metadata.last_accessed_at,
                    freshness = CalendarCacheFreshness.fromWire(metadata.freshness) ?: corrupt(),
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
        row: io.sentient.mobiledata.cache.db.Calendar_month_snapshot,
    ) {
        if (
            row.account_id != namespace.accountId ||
            row.backend_id != namespace.backendId ||
            row.window_start != window.windowStart ||
            row.window_end != window.windowEnd ||
            row.timezone_input != window.timezoneInput ||
            row.fetched_at < 0L ||
            row.last_accessed_at < 0L ||
            CalendarCacheFreshness.fromWire(row.freshness) == null
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
