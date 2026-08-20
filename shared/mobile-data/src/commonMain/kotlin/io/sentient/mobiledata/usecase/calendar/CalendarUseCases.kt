package io.sentient.mobiledata.usecase.calendar

import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.data.calendar.toEntireSeriesUpdate
import io.sentient.mobiledata.data.calendar.withMutationResult
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.toCalendarTime
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** VM-facing get operation; the implementation folds its result into [state]. */
interface GetCalendarUseCase {
    val state: StateFlow<SentientResult<CalendarEvent>>
    suspend fun get(id: String): SentientResult<CalendarEvent>

    /** V2 occurrence-get adapter; legacy callers continue using [get] above. */
    suspend fun get(
        id: String,
        originalStart: String?,
        scope: CalendarScope? = null,
    ): SentientResult<CalendarEvent> = get(id)
}

/** VM-facing V2 mutation command. All recurrence scopes are carried by the command. */
interface MutateCalendarUseCase {
    suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult>
}

/** VM-facing range query; the implementation folds its result into [listState]. */
interface ListCalendarUseCase {
    val listState: StateFlow<SentientResult<CalendarEventPage>>

    /** Existing source-level adapter retained for current platform VMs. */
    suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
    ): SentientResult<CalendarEventPage>

    /** Raw V2 query adapter with optional cursor/search/limit. */
    suspend fun list(
        from: String,
        to: String,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null,
    ): SentientResult<CalendarEventPage> = list(
        from = from.toCalendarTime(),
        to = to.toCalendarTime(),
        scope = scope,
        group = group,
        tags = tags,
        importance = importance,
    )

    /** Existing four-boundary signature is a source adapter, not two requests. */
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

private const val MSG_DELETE_UNRESOLVED =
    "This calendar event could not be resolved safely. Refresh and try again."

interface DeleteCalendarUseCase {
    /** Existing id-only adapter retained for platform source compatibility. */
    suspend fun delete(id: String): SentientResult<Unit>

    /** Carries the selected event's resource scope and revision to the mutation. */
    suspend fun delete(event: CalendarEvent): SentientResult<Unit> = delete(event.eventId)
}

/** Stateless repository plus use-case-owned observable read state. */
class CalendarUseCases(private val repository: CalendarRepository) :
    GetCalendarUseCase,
    ListCalendarUseCase,
    MutateCalendarUseCase,
    CreateCalendarUseCase,
    UpdateCalendarUseCase,
    DeleteCalendarUseCase {

    private val _getState = MutableStateFlow<SentientResult<CalendarEvent>>(SentientResult.Loading())
    override val state: StateFlow<SentientResult<CalendarEvent>> = _getState.asStateFlow()

    private val _listState = MutableStateFlow<SentientResult<CalendarEventPage>>(SentientResult.Loading())
    override val listState: StateFlow<SentientResult<CalendarEventPage>> = _listState.asStateFlow()

    override suspend fun get(id: String): SentientResult<CalendarEvent> = get(id, null, null)

    override suspend fun get(
        id: String,
        originalStart: String?,
        scope: CalendarScope?,
    ): SentientResult<CalendarEvent> {
        _getState.value = SentientResult.Loading()
        return repository.get(id, originalStart, scope).also { _getState.value = it }
    }

    override suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope?,
        group: String?,
        tags: List<String>?,
        importance: Importance?,
    ): SentientResult<CalendarEventPage> = list(
        from = from.toWireValue(),
        to = to.toWireValue(),
        scope = scope,
        group = group,
        tags = tags,
        importance = importance,
    )

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
    ): SentientResult<CalendarEventPage> {
        _listState.value = SentientResult.Loading()
        return repository.list(from, to, scope, group, tags, importance, cursor, query, limit)
            .also { _listState.value = it }
    }

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
        // V2 merges timed and all-day occurrences. Use the explicit all-day
        // date range as the shared raw window: the gateway applies its approved
        // calendar zone when projecting timed occurrences, rather than inheriting
        // a device default timezone from this adapter.
        return list(
            from = allDayFrom.date,
            to = allDayTo.date,
            scope = scope,
            group = group,
            tags = tags,
            importance = importance,
        )
    }

    override suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult> = repository.mutate(eventId, command)

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = repository.create(event)

    override suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> =
        when (val result = repository.mutate(id, event.toEntireSeriesUpdate())) {
            is SentientResult.Success -> SentientResult.Success(event.withMutationResult(result.data))
            is SentientResult.Failure -> result
            is SentientResult.Loading -> SentientResult.Loading(event)
        }

    override suspend fun delete(id: String): SentientResult<Unit> =
        when (val resolved = resolveDeleteEvent(id)) {
            is SentientResult.Success -> delete(resolved.data)
            is SentientResult.Failure -> resolved
            is SentientResult.Loading -> SentientResult.Loading()
        }

    override suspend fun delete(event: CalendarEvent): SentientResult<Unit> {
        if (!event.hasWritableDeleteMetadata()) return unresolvedDeleteFailure()
        return repository.delete(event)
    }

    /**
     * The legacy id-only path has no scope or revision arguments. Prefer the
     * latest unambiguous event already held by this use-case; otherwise reread
     * one authoritative aggregate target before issuing any write.
     */
    private suspend fun resolveDeleteEvent(id: String): SentientResult<CalendarEvent> {
        uniqueDeleteCandidateFromPage(listState.value, id)?.let { return SentientResult.Success(it) }
        uniqueDeleteCandidateFromEvent(state.value, id)?.let { return SentientResult.Success(it) }
        return get(id = id, originalStart = null, scope = CalendarScope.ALL)
    }

    private fun uniqueDeleteCandidateFromPage(
        result: SentientResult<CalendarEventPage>,
        id: String,
    ): CalendarEvent? = when (result) {
        is SentientResult.Success -> result.data.events
            .filter { it.matchesDeleteId(id) }
            .distinctBy { Triple(it.eventId, it.scope, it.revision) }
            .singleOrNull()
        is SentientResult.Failure,
        is SentientResult.Loading,
        -> null
    }

    private fun uniqueDeleteCandidateFromEvent(
        result: SentientResult<CalendarEvent>,
        id: String,
    ): CalendarEvent? = when (result) {
        is SentientResult.Success -> result.data.takeIf { it.matchesDeleteId(id) }
        is SentientResult.Failure,
        is SentientResult.Loading,
        -> null
    }

    private fun CalendarEvent.hasWritableDeleteMetadata(): Boolean =
        (scope == CalendarScope.PRIVATE || scope == CalendarScope.HOUSEHOLD) && revision > 0

    private fun CalendarEvent.matchesDeleteId(id: String): Boolean =
        eventId == id

    private fun unresolvedDeleteFailure(): SentientResult.Failure =
        SentientResult.Failure(SentientError.Protocol(MSG_DELETE_UNRESOLVED))
}

typealias GetCalendarEventUseCase = GetCalendarUseCase
typealias ListCalendarEventsUseCase = ListCalendarUseCase
typealias MutateCalendarEventUseCase = MutateCalendarUseCase
typealias CreateCalendarEventUseCase = CreateCalendarUseCase
typealias UpdateCalendarEventUseCase = UpdateCalendarUseCase
typealias DeleteCalendarEventUseCase = DeleteCalendarUseCase
