package io.sentient.android.settings.calendar

import io.sentient.mobiledata.calendar.CalendarExperienceState
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.projectCalendar
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class CalendarScreenAssemblyTest {
    private val occurrence = EffectiveOccurrence(
        eventId = "event/opaque",
        occurrenceId = "occurrence:opaque",
        originalStart = "2026-08-24T09:00:00-04:00",
        recurring = true,
        revision = 5,
        scope = CalendarScope.HOUSEHOLD,
        title = "Private family content",
        start = "2026-08-24T09:00:00-04:00",
        end = "2026-08-24T10:00:00-04:00",
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
    )

    @Test
    fun back_always_dismisses_the_top_overlay_before_route_navigation() {
        assertEquals(CalendarBackAction.DISMISS_OVERLAY, calendarBackAction(true))
        assertEquals(CalendarBackAction.NAVIGATE_UP, calendarBackAction(false))
    }

    @Test
    fun preview_lookup_returns_the_exact_authorized_occurrence_and_rejects_stale_identity() {
        val event = state(CalendarView.DAY).visibleEvents.single()
        assertSame(occurrence, authorizedOccurrenceFor(event, listOf(occurrence)))
        assertNull(authorizedOccurrenceFor(event, listOf(occurrence.copy(revision = 6))))
        assertNull(authorizedOccurrenceFor(event, listOf(occurrence.copy(originalStart = "2026-08-31T09:00:00-04:00"))))
    }

    @Test
    fun stable_tags_are_content_free_and_resource_id_safe() {
        val eventTag = calendarEventTag(state(CalendarView.DAY).visibleEvents.single())
        assertFalse(eventTag.contains(occurrence.title))
        assertTrue(eventTag.matches(Regex("calendar-event-[0-9a-f]{24}")))
        assertEquals("calendar-view-month", calendarViewTag(CalendarView.MONTH))
        assertEquals("calendar-date-2026-08-24", calendarDateTag("2026-08-24"))
        assertEquals("calendar-filter-option-d34a569ab7aaa54dacd715ae", calendarFilterTag("option", "family"))
    }

    @Test
    fun headings_and_month_agenda_use_the_shared_projection_slice() {
        val day = state(CalendarView.DAY)
        val week = state(CalendarView.WEEK)
        val month = state(CalendarView.MONTH)
        val year = state(CalendarView.YEAR)

        assertEquals("August 24", calendarHeadingTitle(day))
        assertEquals("Aug 23–29", calendarHeadingTitle(week))
        assertEquals("August 2026", calendarHeadingTitle(month))
        assertEquals("2026", calendarHeadingTitle(year))
        assertEquals("Monday · 24", calendarHeadingSubtitle(month))
        assertEquals("Year at a glance", calendarHeadingSubtitle(year))
        assertEquals(month.month?.agenda?.map { it.date }, calendarAgendaSections(month).map { it.date })
        assertSame(month.visibleEvents.single(), calendarAgendaSections(month).single().events.single())
        assertTrue(calendarAgendaSections(year).isEmpty())
    }

    @Test
    fun filter_toggles_preserve_every_other_shared_filter_field() {
        val filters = CalendarFilters(scope = CalendarScope.HOUSEHOLD, text = "query", tags = setOf("school"))
        val withGroup = filters.toggleGroup("Family")
        val withoutTag = withGroup.toggleTag("school")

        assertEquals(setOf("Family"), withGroup.groups)
        assertEquals(CalendarScope.HOUSEHOLD, withGroup.scope)
        assertEquals("query", withGroup.text)
        assertTrue(withoutTag.tags.isEmpty())
    }

    private fun state(view: CalendarView): CalendarUiState {
        val projected = projectCalendar(
            occurrences = listOf(occurrence),
            anchorDate = "2026-08-24",
            selectedDate = "2026-08-24",
            todayDate = "2026-08-24",
            view = view,
        )
        return CalendarExperienceState(
            anchorDate = projected.anchorDate,
            selectedDate = projected.selectedDate,
            todayDate = projected.todayDate,
            view = view,
            locale = projected.locale,
            projection = projected,
            facets = projected.facets,
            authorizedOccurrences = listOf(occurrence),
        ).toAndroidUiState()
    }
}
