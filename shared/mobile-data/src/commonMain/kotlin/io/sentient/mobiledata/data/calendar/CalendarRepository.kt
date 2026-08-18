package io.sentient.mobiledata.data.calendar

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance

/** Stateless calendar data source consumed by calendar use cases. */
interface CalendarRepository {
    suspend fun get(id: String): SentientResult<CalendarEvent>
    suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
    ): SentientResult<CalendarEventPage>
    suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent>
    suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent>
    suspend fun delete(id: String): SentientResult<Unit>
}
