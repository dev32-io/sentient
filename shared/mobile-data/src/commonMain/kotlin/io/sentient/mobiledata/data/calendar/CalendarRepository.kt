package io.sentient.mobiledata.data.calendar

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarChanges
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.CalendarPatch
import io.sentient.mobilesdk.result.SentientError

private const val MSG_DELETE_UNRESOLVED =
    "This calendar event could not be resolved safely. Refresh and try again."

/**
 * Stateless V2 calendar data source. Temporal query values remain raw strings at
 * this boundary so a repository never invents a device timezone or folds pages.
 */
interface CalendarRepository {
    suspend fun get(
        id: String,
        originalStart: String? = null,
        scope: CalendarScope? = null,
    ): SentientResult<CalendarEvent>

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
    ): SentientResult<CalendarEventPage>

    /** Source compatibility adapter for callers that already hold CalendarTime. */
    suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null,
    ): SentientResult<CalendarEventPage> = list(
        from = from.toWireValue(),
        to = to.toWireValue(),
        scope = scope,
        group = group,
        tags = tags,
        importance = importance,
        cursor = cursor,
        query = query,
        limit = limit,
    )

    suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent>
    suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent>

    suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult>

    /** Whole-series adapter retained for existing repository callers. */
    suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> =
        when (val result = mutate(id, event.toEntireSeriesUpdate())) {
            is SentientResult.Success -> SentientResult.Success(event.withMutationResult(result.data))
            is SentientResult.Failure -> result
            is SentientResult.Loading -> error("A repository mutation cannot return Loading")
        }

    /** Whole-series adapter retained for existing repository callers. */
    suspend fun delete(id: String, expectedRevision: Int? = null): SentientResult<Unit> =
        unresolvedDeleteFailure()

    /** Whole-series delete adapter for callers holding the selected event. */
    suspend fun delete(event: CalendarEvent): SentientResult<Unit> = delete(
        id = event.persistedId,
        scope = event.scope,
        expectedRevision = event.revision.takeIf { it > 0 },
    )

    /** Whole-series delete adapter with explicit mutation metadata. */
    suspend fun delete(
        id: String,
        scope: CalendarScope?,
        expectedRevision: Int? = null,
    ): SentientResult<Unit> {
        val writableScope = scope?.takeUnless { it == CalendarScope.ALL }
        if ((writableScope != CalendarScope.PRIVATE && writableScope != CalendarScope.HOUSEHOLD) || expectedRevision == null || expectedRevision <= 0) {
            return unresolvedDeleteFailure()
        }
        return when (val result = mutate(id, CalendarMutationCommand.delete(
            applyTo = io.sentient.mobilesdk.calendar.CalendarMutationScope.ENTIRE_SERIES,
            scope = writableScope,
            expectedRevision = expectedRevision,
        ))) {
            is SentientResult.Success -> SentientResult.Success(Unit)
            is SentientResult.Failure -> result
            is SentientResult.Loading -> error("A repository mutation cannot return Loading")
        }
    }
}

private fun unresolvedDeleteFailure(): SentientResult.Failure =
    SentientResult.Failure(SentientError.Protocol(MSG_DELETE_UNRESOLVED))

internal fun CalendarEvent.toEntireSeriesUpdate(): CalendarMutationCommand = CalendarMutationCommand.update(
    applyTo = io.sentient.mobilesdk.calendar.CalendarMutationScope.ENTIRE_SERIES,
    changes = CalendarChanges(
        title = title,
        description = description.toPatch(),
        start = start.toWireValue(),
        end = end?.toWireValue()?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
        visibility = visibility,
        importance = importance,
        group = group?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
        tags = tags,
        recurrence = recurrence?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
    ),
    scope = scope.takeUnless { it == CalendarScope.ALL },
    expectedRevision = revision.takeIf { it > 0 },
)

private fun String?.toPatch(): CalendarPatch<String> = this?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear

internal fun CalendarEvent.withMutationResult(result: CalendarMutationResult): CalendarEvent = copy(
    id = result.eventId,
    revision = result.resultingRevision ?: revision,
    occurrenceId = null,
    baseEventId = null,
)
