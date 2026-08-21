package io.sentient.android.calendar

import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.calendar.CalendarExperience

/** Content-free reasons a protected calendar database cannot be made available. */
enum class CalendarSessionUnavailableReason {
    INITIALIZING,
    AUTHENTICATED_ID_MISSING,
    BACKEND_IDENTITY_INVALID,
    DATABASE_OPEN,
}

/** Typed Android session boundary state; no fallback store is represented here. */
sealed interface CalendarSessionState {
    data object Unauthenticated : CalendarSessionState

    data class Available(
        val namespace: CalendarCacheNamespace,
        val experience: CalendarExperience,
    ) : CalendarSessionState

    data class Unavailable(
        val reason: CalendarSessionUnavailableReason,
    ) : CalendarSessionState
}
