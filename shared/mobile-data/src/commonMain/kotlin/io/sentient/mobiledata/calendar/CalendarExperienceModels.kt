package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobilesdk.calendar.CalendarScope

/** Freshness of the data currently rendered by [CalendarExperience]. */
typealias CalendarFreshness = CalendarCacheFreshness

enum class CalendarLoadingPhase {
    IDLE,
    LOADING,
    REFRESHING,
}

/**
 * Loading is separate from content.  A refresh never requires a consumer to
 * replace usable cached content with a blank loading screen.
 */
data class CalendarLoadingState(
    val phase: CalendarLoadingPhase = CalendarLoadingPhase.IDLE,
) {
    val isLoading: Boolean get() = phase != CalendarLoadingPhase.IDLE
    val isRefreshing: Boolean get() = phase == CalendarLoadingPhase.REFRESHING
    val isInitial: Boolean get() = phase == CalendarLoadingPhase.LOADING
}

enum class CalendarOfflineState {
    ONLINE,
    OFFLINE,
    UNAVAILABLE,
}

enum class CalendarMutationAvailabilityReason {
    OFFLINE,
    UNAVAILABLE,
    AUTHORIZATION,
    ERROR,
}

/**
 * Shared read/mutation availability gate. Cached-offline and unavailable-offline
 * states disable writes without creating a durable mutation queue; role-specific
 * authorization remains a typed repository outcome.
 */
data class CalendarMutationAvailability(
    val canCreate: Boolean = true,
    val canEdit: Boolean = true,
    val canDelete: Boolean = true,
    val reason: CalendarMutationAvailabilityReason? = null,
) {
    val isAvailable: Boolean get() = canCreate || canEdit || canDelete
    val available: Boolean get() = isAvailable
}

enum class CalendarExperienceErrorKind {
    CACHE,
    CONNECTION,
    /** The requested interval is not cached and cannot be loaded offline. */
    UNAVAILABLE_OFFLINE,
    AUTHORIZATION,
    FORBIDDEN,
    MALFORMED,
    DECODE,
    CONTRACT,
    DATABASE,
    UNKNOWN,
}

/**
 * Sanitized coordinator error.  It intentionally contains no throwable, HTTP
 * body, event title, filter value, search text, or server diagnostic.
 */
data class CalendarExperienceError(
    val kind: CalendarExperienceErrorKind,
    val userMessage: String,
    val recoverable: Boolean = true,
) {
    val message: String get() = userMessage
    val category: CalendarExperienceErrorKind get() = kind
    val isOffline: Boolean get() = kind == CalendarExperienceErrorKind.CONNECTION || kind == CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE
    val isUnavailableOffline: Boolean get() = kind == CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE
}

typealias CalendarReadError = CalendarExperienceError

/** A stable identity used while folding pages before committing a snapshot. */
data class CalendarOccurrenceIdentity(
    val eventId: String,
    val occurrenceId: String,
    val originalStart: String,
    val scope: CalendarScope,
) {
    val stableKey: String
        get() = listOf(eventId, occurrenceId, originalStart, scope.name)
            .joinToString("") { "${it.length}:$it" }
}

/**
 * Small public aliases make the state pleasant to consume from both Kotlin and
 * generated Swift without exposing any SQLDelight row types.
 */
typealias CalendarLoading = CalendarLoadingState
typealias CalendarOffline = CalendarOfflineState

internal fun emptyCalendarFacets(): CalendarFacetOptions = CalendarFacetOptions(
    scopes = listOf(CalendarScope.ALL),
    groups = emptyList(),
    tags = emptyList(),
    importances = emptyList(),
)
