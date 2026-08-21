@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package io.sentient.mobiledata.di

import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.concurrent.atomics.AtomicReference

/** Structural reasons exposed when authenticated calendar persistence is disabled. */
enum class CalendarDependencyUnavailableReason {
    INITIALIZING,
    MISSING_AUTHENTICATED_USER_ID,
    INVALID_BACKEND_IDENTITY,
    PROTECTED_STORAGE,
    DATABASE_OPEN,
    MIGRATION_FAILED,
    STORE_OPEN_FAILED,
    CLOSED,
}

/** Explicit state of a session's protected calendar dependency. */
sealed interface CalendarDependencyState {
    data class Unavailable(val reason: CalendarDependencyUnavailableReason) : CalendarDependencyState
    data class Available(val experience: CalendarExperience) : CalendarDependencyState
}

/**
 * Mutable only at the authenticated-session boundary. A session creates this
 * boundary before asynchronous database setup starts, so SettingsComponent can
 * never fall back to a network-only repository while protected persistence is
 * opening or failing.
 */
class CalendarDependencyBoundary private constructor(
    initialReason: CalendarDependencyUnavailableReason,
) {
    private val unavailableRepository = DisabledCalendarRepository()
    private val delegate = DelegatingCalendarRepository(unavailableRepository)
    private val closed = AtomicReference(initialReason == CalendarDependencyUnavailableReason.CLOSED)
    private val _state = MutableStateFlow<CalendarDependencyState>(
        CalendarDependencyState.Unavailable(initialReason),
    )

    /** Repository used by settings use cases; it remains fail-closed until install. */
    val repository: CalendarRepository = delegate
    val state: StateFlow<CalendarDependencyState> = _state.asStateFlow()
    val experience: CalendarExperience?
        get() = (_state.value as? CalendarDependencyState.Available)?.experience

    /** Install the database-backed repository and experience at the boundary. */
    fun install(repository: CalendarRepository, experience: CalendarExperience): Boolean {
        // Close is a terminal session fence. An initializer racing disposal may
        // finish opening a driver, but it must not republish that resource.
        if (closed.load()) return false
        delegate.replace(repository)
        if (closed.load()) {
            delegate.replace(unavailableRepository)
            return false
        }
        _state.value = CalendarDependencyState.Available(experience)
        return true
    }

    /** Disable the dependency and make subsequent use-case calls fail closed. */
    fun disable(reason: CalendarDependencyUnavailableReason) {
        if (reason == CalendarDependencyUnavailableReason.CLOSED) closed.store(true)
        delegate.replace(unavailableRepository)
        _state.value = CalendarDependencyState.Unavailable(reason)
    }

    companion object {
        fun initializing(): CalendarDependencyBoundary = CalendarDependencyBoundary(
            CalendarDependencyUnavailableReason.INITIALIZING,
        )

        fun unavailable(reason: CalendarDependencyUnavailableReason): CalendarDependencyBoundary =
            CalendarDependencyBoundary(reason)
    }
}

/** Repository delegate avoids exposing a remote repository before protected setup succeeds. */
private class DelegatingCalendarRepository(initial: CalendarRepository) : CalendarRepository {
    private val current = AtomicReference(initial)

    fun replace(repository: CalendarRepository) {
        current.store(repository)
    }

    override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?): SentientResult<CalendarEvent> =
        current.load().get(id, originalStart, scope)

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
    ): SentientResult<CalendarEventPage> = current.load().list(from, to, scope, group, tags, importance, cursor, query, limit)

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = current.load().create(event)

    override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> = current.load().create(input)

    override suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult> = current.load().mutate(eventId, command)
}

/** No content-bearing error is retained or returned when protected storage is unavailable. */
private class DisabledCalendarRepository : CalendarRepository {
    private fun <T : Any> failure(): SentientResult<T> = SentientResult.Failure(
        SentientError.Protocol("Calendar persistence is unavailable."),
    )

    override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?): SentientResult<CalendarEvent> = failure()

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
    ): SentientResult<CalendarEventPage> = failure()

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = failure()

    override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> = failure()

    override suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult> = failure()
}
