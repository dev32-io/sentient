package io.sentient.android.settings.calendar

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlin.test.Test
import kotlin.test.assertEquals

class CalendarViewModelTest {
    private val event = CalendarEvent(
        id = "event-1", scope = CalendarScope.HOUSEHOLD, title = "Dinner",
        start = CalendarTime.AllDay("2026-08-01"), visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL, createdAt = "now", updatedAt = "now",
    )

    @Test
    fun successful_list_replaces_events_and_clears_error() {
        val state = CalendarUiState(error = "old")
            .foldList(SentientResult.Success(CalendarEventPage(listOf(event), 0)))
        assertEquals(listOf(event), state.events)
        assertEquals(false, state.loading)
        assertEquals(null, state.error)
    }

    @Test
    fun failed_list_preserves_existing_events_for_retry() {
        val state = CalendarUiState(events = listOf(event))
            .foldList(SentientResult.Failure(io.sentient.mobilesdk.result.SentientError.Unknown("Calendar unavailable")))
        assertEquals(listOf(event), state.events)
        assertEquals("Calendar unavailable", state.error)
        assertEquals(false, state.loading)
    }
}
