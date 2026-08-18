package io.sentient.mobiledata.data.calendar

import io.sentient.mobiledata.data.settings.toEnvelope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance

/** SDK-backed calendar repository. It deliberately owns no cache or accumulated state. */
class SdkCalendarRepository(private val client: CalendarHttpClient) : CalendarRepository {
    override suspend fun get(id: String): SentientResult<CalendarEvent> = client.get(id).toEnvelope()

    override suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope?,
        group: String?,
        tags: List<String>?,
        importance: Importance?,
    ): SentientResult<CalendarEventPage> = client.list(from, to, scope, group, tags, importance).toEnvelope()

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = client.create(event).toEnvelope()

    override suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> =
        client.update(id, event).toEnvelope()

    override suspend fun delete(id: String): SentientResult<Unit> = client.delete(id).toEnvelope()
}
