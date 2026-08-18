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

    /**
     * Lists both time kinds without ever passing a mixed-kind window to the
     * gateway. The REST/store contract requires one kind per request, so the
     * platform screens use this operation for their combined calendar view.
     */
    suspend fun listBoth(
        timedFrom: CalendarTime.Timed,
        timedTo: CalendarTime.Timed,
        allDayFrom: CalendarTime.AllDay,
        allDayTo: CalendarTime.AllDay,
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
    ): SentientResult<CalendarEventPage> = listBoth(
        timedFrom = from.asTimedBoundary(end = false),
        timedTo = to.asTimedBoundary(end = true),
        allDayFrom = from.asAllDayBoundary(),
        allDayTo = to.asAllDayBoundary(),
        scope = scope,
        group = group,
        tags = tags,
        importance = importance,
    )

    override suspend fun listBoth(
        timedFrom: CalendarTime.Timed,
        timedTo: CalendarTime.Timed,
        allDayFrom: CalendarTime.AllDay,
        allDayTo: CalendarTime.AllDay,
        scope: CalendarScope?,
        group: String?,
        tags: List<String>?,
        importance: Importance?,
    ): SentientResult<CalendarEventPage> {
        _listState.value = SentientResult.Loading()

        // Keep these as two independent repository calls. The gateway and store
        // deliberately reject a window whose endpoints do not have one time kind,
        // and a calendar can contain both kinds at once.
        val timed = repository.list(timedFrom, timedTo, scope, group, tags, importance)
        if (timed !is SentientResult.Success) {
            _listState.value = timed
            return timed
        }
        val allDay = repository.list(allDayFrom, allDayTo, scope, group, tags, importance)
        if (allDay !is SentientResult.Success) {
            _listState.value = allDay
            return allDay
        }

        val events = (timed.data.events + allDay.data.events)
            .distinctBy { it.occurrenceId ?: it.id }
            .sortedWith(compareBy<CalendarEvent>({ it.start.sortKey() }, { it.occurrenceId ?: it.id }))
        return SentientResult.Success(CalendarEventPage(events, timed.data.more + allDay.data.more)).also {
            _listState.value = it
        }
    }

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = repository.create(event)

    override suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> =
        repository.update(id, event)

    override suspend fun delete(id: String): SentientResult<Unit> = repository.delete(id)
}

private fun CalendarTime.asTimedBoundary(end: Boolean): CalendarTime.Timed = when (this) {
    is CalendarTime.Timed -> this
    is CalendarTime.AllDay -> CalendarTime.Timed(
        instant = "${date}T${if (end) "23:59:59.999Z" else "00:00:00.000Z"}",
        timeZoneId = "UTC",
    )
}

private fun CalendarTime.asAllDayBoundary(): CalendarTime.AllDay = when (this) {
    is CalendarTime.AllDay -> this
    is CalendarTime.Timed -> CalendarTime.AllDay(instant.take(10))
}

private fun CalendarTime.sortKey(): String = when (this) {
    is CalendarTime.AllDay -> date
    is CalendarTime.Timed -> instant.take(10)
}

/** Explicitly named aliases for platform DI consumers that prefer operation names. */
typealias GetCalendarEventUseCase = GetCalendarUseCase
typealias ListCalendarEventsUseCase = ListCalendarUseCase
typealias CreateCalendarEventUseCase = CreateCalendarUseCase
typealias UpdateCalendarEventUseCase = UpdateCalendarUseCase
typealias DeleteCalendarEventUseCase = DeleteCalendarUseCase
