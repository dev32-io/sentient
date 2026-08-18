package io.sentient.mobiledata.usecase.calendar

import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** VM-facing read operation; the implementation folds its result into [state]. */
interface GetCalendarUseCase {
    val state: StateFlow<SentientResult<CalendarEvent>>
    suspend fun get(id: String): SentientResult<CalendarEvent>
}

/** VM-facing range query; the implementation folds its result into [state]. */
interface ListCalendarUseCase {
    val listState: StateFlow<SentientResult<CalendarEventPage>>
    suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
    ): SentientResult<CalendarEventPage>
}

interface CreateCalendarUseCase {
    suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent>
}

interface UpdateCalendarUseCase {
    suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent>
}

interface DeleteCalendarUseCase {
    suspend fun delete(id: String): SentientResult<Unit>
}

/**
 * Stateless repository plus use-case-owned observable read state. CRUD results are
 * returned directly so a VM can decide how to fold them into its screen state.
 */
class CalendarUseCases(private val repository: CalendarRepository) :
    GetCalendarUseCase,
    ListCalendarUseCase,
    CreateCalendarUseCase,
    UpdateCalendarUseCase,
    DeleteCalendarUseCase {

    private val _getState = MutableStateFlow<SentientResult<CalendarEvent>>(SentientResult.Loading())
    override val state: StateFlow<SentientResult<CalendarEvent>> = _getState.asStateFlow()

    private val _listState = MutableStateFlow<SentientResult<CalendarEventPage>>(SentientResult.Loading())
    override val listState: StateFlow<SentientResult<CalendarEventPage>> = _listState.asStateFlow()

    override suspend fun get(id: String): SentientResult<CalendarEvent> = repository.get(id).also { _getState.value = it }

    override suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope?,
        group: String?,
        tags: List<String>?,
        importance: Importance?,
    ): SentientResult<CalendarEventPage> = repository.list(from, to, scope, group, tags, importance).also {
        _listState.value = it
    }

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = repository.create(event)

    override suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> =
        repository.update(id, event)

    override suspend fun delete(id: String): SentientResult<Unit> = repository.delete(id)
}

/** Explicitly named aliases for platform DI consumers that prefer operation names. */
typealias GetCalendarEventUseCase = GetCalendarUseCase
typealias ListCalendarEventsUseCase = ListCalendarUseCase
typealias CreateCalendarEventUseCase = CreateCalendarUseCase
typealias UpdateCalendarEventUseCase = UpdateCalendarUseCase
typealias DeleteCalendarEventUseCase = DeleteCalendarUseCase
