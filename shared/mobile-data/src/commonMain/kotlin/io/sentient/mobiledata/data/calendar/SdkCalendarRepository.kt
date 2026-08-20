package io.sentient.mobiledata.data.calendar

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance

/** SDK-backed calendar repository. It deliberately owns no cache or accumulated state. */
class SdkCalendarRepository(private val client: CalendarHttpClient) : CalendarRepository {
    override suspend fun get(
        id: String,
        originalStart: String?,
        scope: CalendarScope?,
    ): SentientResult<CalendarEvent> = client.get(id, scope, originalStart).toCalendarEnvelope()

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
    ): SentientResult<CalendarEventPage> = client.list(
        from = from,
        to = to,
        scope = scope,
        group = group,
        tags = tags,
        importance = importance,
        cursor = cursor,
        query = query,
        limit = limit,
    ).toCalendarEnvelope()

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> =
        client.create(event).toCalendarEnvelope()

    override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> =
        client.create(input).toCalendarEnvelope()

    override suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult> = client.mutate(eventId, command).toCalendarEnvelope()
}
