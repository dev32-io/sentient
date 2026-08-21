package io.sentient.mobiledata.cache.db

import kotlinx.coroutines.Dispatchers
import kotlin.coroutines.CoroutineContext

/** Compatibility aliases for callers colocated with the database foundation. */
typealias CalendarCacheNamespace = io.sentient.mobiledata.cache.CalendarCacheNamespace
typealias CalendarCacheWindow = io.sentient.mobiledata.cache.CalendarCacheWindow
typealias CalendarCacheSnapshot = io.sentient.mobiledata.cache.CalendarCacheSnapshot
typealias CalendarCachePreferences = io.sentient.mobiledata.cache.CalendarCachePreferences
typealias CalendarCacheWindowMetadata = io.sentient.mobiledata.cache.CalendarCacheWindowMetadata
typealias CalendarCacheStore = io.sentient.mobiledata.cache.CalendarCacheStore
typealias SqlDelightCalendarCacheStore = io.sentient.mobiledata.cache.SqlDelightCalendarCacheStore
typealias CalendarCacheResult<T> = io.sentient.mobiledata.cache.CalendarCacheResult<T>
typealias CalendarCacheReadResult<T> = io.sentient.mobiledata.cache.CalendarCacheReadResult<T>
typealias CalendarCacheWriteResult = io.sentient.mobiledata.cache.CalendarCacheWriteResult
typealias CalendarCacheFailure = io.sentient.mobiledata.cache.CalendarCacheFailure
typealias CalendarCacheFailureReason = io.sentient.mobiledata.cache.CalendarCacheFailureReason
typealias CalendarCacheFreshness = io.sentient.mobiledata.cache.CalendarCacheFreshness
const val CALENDAR_CACHE_MAX_RETAINED_WINDOWS: Int = io.sentient.mobiledata.cache.CALENDAR_CACHE_MAX_RETAINED_WINDOWS

fun createCalendarCacheStore(
    handle: CalendarDatabaseHandle,
    namespace: CalendarCacheNamespace,
    observationContext: CoroutineContext = Dispatchers.Default,
): CalendarCacheStore = io.sentient.mobiledata.cache.createCalendarCacheStore(handle, namespace, observationContext)

fun createCalendarCacheStore(
    handle: CalendarDatabaseHandle,
    accountId: String,
    backendId: String,
    observationContext: CoroutineContext = Dispatchers.Default,
): CalendarCacheStore = io.sentient.mobiledata.cache.createCalendarCacheStore(handle, accountId, backendId, observationContext)
