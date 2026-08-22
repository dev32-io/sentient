package io.sentient.mobiledata.calendar

import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Weekday
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class CalendarProjectionTest {
    @Test
    fun year_projection_contains_complete_leap_and_long_months() {
        val projection = projectCalendarOccurrences(
            occurrences = emptyList(),
            state = CalendarExperienceState(
                anchorDate = "2024-06-18",
                view = CalendarView.YEAR,
                selectedDate = "2024-06-18",
                todayDate = "2024-06-18",
            ),
        )

        assertEquals(12, projection.year?.months?.size)
        assertEquals(29, projection.year?.months?.single { it.month == 2 }?.days?.size)
        assertEquals(31, projection.year?.months?.single { it.month == 1 }?.days?.size)
        assertEquals("2024-02-29", projection.year?.months?.single { it.month == 2 }?.days?.last()?.date)
        assertEquals("2024-04-30", projection.year?.months?.single { it.month == 4 }?.days?.last()?.date)
        assertEquals("2024-12-31", projection.year?.months?.last()?.days?.last()?.date)
    }

    @Test
    fun month_is_42_cells_and_respects_locale_week_start() {
        val sundayMonth = projectCalendarOccurrences(
            occurrences = emptyList(),
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                view = CalendarView.MONTH,
                locale = CalendarLocale(languageTag = "en-US", timeZoneId = "UTC"),
            ),
        )
        val mondayMonth = projectCalendarOccurrences(
            occurrences = emptyList(),
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                view = CalendarView.MONTH,
                locale = CalendarLocale(languageTag = "de-DE", timeZoneId = "UTC"),
            ),
        )

        assertEquals(42, sundayMonth.month?.cells?.size)
        assertEquals("2026-07-26", sundayMonth.month?.cells?.first()?.date)
        assertEquals(42, mondayMonth.month?.cells?.size)
        assertEquals("2026-07-27", mondayMonth.month?.cells?.first()?.date)
        assertEquals(Weekday.SUNDAY, sundayMonth.month?.weekdayLabels?.first()?.weekday)
        assertEquals(Weekday.MONDAY, mondayMonth.month?.weekdayLabels?.first()?.weekday)
        assertTrue(sundayMonth.month?.cells?.first()?.isOutsideMonth == true)
    }

    @Test
    fun month_agenda_is_the_event_bearing_slice_of_four_days_from_anchor() {
        val projection = projectCalendarOccurrences(
            occurrences = listOf(
                occurrence(id = "anchor", title = "Anchor", start = "2026-08-15T09:00:00Z"),
                occurrence(id = "third", title = "Third", start = "2026-08-17T09:00:00Z"),
                occurrence(id = "fifth", title = "Fifth", start = "2026-08-19T09:00:00Z"),
            ),
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                selectedDate = "2026-08-01",
                view = CalendarView.MONTH,
                locale = CalendarLocale(timeZoneId = "UTC"),
            ),
        )

        assertEquals(listOf("2026-08-15", "2026-08-17"), projection.month?.agenda?.map { it.date })
        assertEquals(listOf("anchor", "third"), projection.month?.agenda?.flatMap { it.events }?.map { it.eventId })
    }

    @Test
    fun named_zone_projection_handles_dst_without_rewriting_raw_values() {
        val occurrence = occurrence(
            id = "dst",
            title = "DST",
            start = "2026-03-08T10:30:00Z",
            originalStart = "2026-03-08T10:30:00-05:00",
        )
        val projection = projectCalendarOccurrences(
            occurrences = listOf(occurrence),
            state = CalendarExperienceState(
                anchorDate = "2026-03-08",
                view = CalendarView.DAY,
                locale = CalendarLocale(languageTag = "en-US", timeZoneId = "America/Los_Angeles"),
            ),
        )
        val event = assertNotNull(projection.day).events.single()
        val timed = assertNotNull(event.start as? CalendarProjectedTime.Timed)

        assertEquals("2026-03-08T10:30:00Z", timed.rawValue)
        assertEquals("2026-03-08", timed.date)
        assertEquals("03:30", timed.localTime)
        assertEquals("2026-03-08T10:30:00-05:00", event.originalStart)
        assertEquals("3:30 AM", timed.displayTime)
    }

    @Test
    fun offset_timestamps_without_seconds_are_projected_and_preserved() {
        val occurrence = occurrence(
            id = "no-seconds",
            title = "No seconds",
            start = "2026-03-08T10:30-05:00",
            originalStart = "2026-03-08T10:30-05:00",
        )
        val projection = projectCalendarOccurrences(
            occurrences = listOf(occurrence),
            state = CalendarExperienceState(
                anchorDate = "2026-03-08",
                view = CalendarView.DAY,
                locale = CalendarLocale(timeZoneId = "UTC"),
            ),
        )
        val event = assertNotNull(projection.day).events.single()
        assertEquals("2026-03-08T10:30-05:00", event.start.rawValue)
        assertEquals("2026-03-08T10:30-05:00", event.originalStart)
    }

    @Test
    fun all_day_occurrences_keep_date_identity_across_device_zones() {
        val occurrence = occurrence(
            id = "all-day",
            title = "Holiday",
            start = "2026-11-01",
            end = "2026-11-02",
            originalStart = "2026-11-01",
        )
        val projection = projectCalendarOccurrences(
            occurrences = listOf(occurrence),
            state = CalendarExperienceState(
                anchorDate = "2026-11-01",
                view = CalendarView.DAY,
                locale = CalendarLocale(languageTag = "en-GB", timeZoneId = "Pacific/Kiritimati"),
            ),
        )
        val event = assertNotNull(projection.day).events.single()
        val allDay = assertNotNull(event.start as? CalendarProjectedTime.AllDay)

        assertEquals("2026-11-01", allDay.date)
        assertEquals("2026-11-01", allDay.rawValue)
        assertEquals("2026-11-01", event.originalStart)
        assertEquals(CalendarEventKind.ALL_DAY, event.kind)
        assertTrue(event.dateRange.contains("2026-11-01"))
        assertFalse(event.dateRange.contains("2026-11-02"))
    }

    @Test
    fun dense_day_exposes_three_indicators_and_overflow_without_losing_actions() {
        val events = (1..5).map { number ->
            occurrence(
                id = "event-$number",
                title = "Event $number",
                start = "2026-08-15T${(8 + number).toString().padStart(2, '0')}:00:00Z",
            )
        }
        val projection = projectCalendarOccurrences(
            occurrences = events,
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                view = CalendarView.MONTH,
                locale = CalendarLocale(timeZoneId = "UTC"),
            ),
        )
        val cell = projection.month?.cells?.single { it.date == "2026-08-15" }

        assertEquals(5, cell?.events?.size)
        assertEquals(3, cell?.indicators?.size)
        assertEquals(2, cell?.overflow?.count)
        assertEquals("+2 more", cell?.overflow?.label)
        assertEquals("event-5", cell?.events?.last()?.eventId)
        assertTrue(cell?.accessibilityLabel?.contains("5 events") == true)
    }

    @Test
    fun filters_intersect_locally_and_facets_come_from_unfiltered_authorized_data() {
        val events = listOf(
            occurrence(
                id = "private-match",
                title = "Alpha school",
                start = "2026-08-15T09:00:00Z",
                scope = CalendarScope.PRIVATE,
                importance = Importance.IMPORTANT,
                group = "School",
                tags = listOf("Family", "Blue"),
            ),
            occurrence(
                id = "household-other",
                title = "Alpha trip",
                start = "2026-08-15T10:00:00Z",
                scope = CalendarScope.HOUSEHOLD,
                importance = Importance.PINNED,
                group = "Travel",
                tags = listOf("Family", "Away"),
            ),
        )
        val matching = projectCalendarOccurrences(
            occurrences = events,
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                view = CalendarView.DAY,
                filters = CalendarFilters(
                    scope = CalendarScope.PRIVATE,
                    groups = setOf("school"),
                    tags = setOf("family"),
                    importance = Importance.IMPORTANT,
                    text = "SCHOOL",
                ),
            ),
        )

        assertEquals(listOf("private-match"), matching.filteredOccurrences.map { it.eventId })
        assertEquals(listOf("Away", "Blue", "Family"), matching.facets.tags)
        assertEquals(listOf("School", "Travel"), matching.facets.groups)
        assertEquals(listOf(Importance.IMPORTANT, Importance.PINNED), matching.facets.importances)
        assertTrue(CalendarScope.ALL in matching.facets.scopes)
        assertTrue(CalendarScope.HOUSEHOLD in matching.facets.scopes)

        val absent = projectCalendarOccurrences(
            occurrences = events,
            state = CalendarExperienceState(
                anchorDate = "2026-08-15",
                view = CalendarView.DAY,
                filters = CalendarFilters(groups = setOf("missing"), tags = setOf("old-tag")),
            ),
        )
        assertTrue(absent.filteredOccurrences.isEmpty())
        assertTrue("missing" in absent.facets.groups)
        assertTrue("old-tag" in absent.facets.tags)
    }

    @Test
    fun navigation_pins_view_transitions_and_active_interval_steps() {
        val monthState = CalendarExperienceState(
            anchorDate = "2026-08-15",
            view = CalendarView.MONTH,
            selectedDate = "2026-08-15",
            todayDate = "2026-08-15",
        )
        val monthToDay = CalendarNavigation.reduce(
            monthState,
            CalendarNavigationAction.SelectDate("2026-08-22"),
        )
        assertEquals(CalendarView.DAY, monthToDay.state.view)
        assertEquals("2026-08-22", monthToDay.state.anchorDate)
        assertIs<CalendarNavigationTarget.Day>(monthToDay.target)

        val weekState = monthState.copy(view = CalendarView.WEEK, anchorDate = "2026-08-12")
        val weekSelection = CalendarNavigation.reduce(
            weekState,
            CalendarNavigationAction.SelectDate("2026-08-15"),
        )
        assertEquals(CalendarView.WEEK, weekSelection.state.view)
        assertEquals("2026-08-12", weekSelection.state.anchorDate)
        assertEquals("2026-08-15", weekSelection.state.selectedDate)
        assertEquals("2026-08-19", CalendarNavigation.next(weekSelection.state).anchorDate)

        val yearResult = CalendarNavigation.reduce(
            monthState.copy(view = CalendarView.YEAR, anchorDate = "2026-01-10"),
            CalendarNavigationAction.SelectMonth(2024, 2),
        )
        assertEquals(CalendarView.MONTH, yearResult.state.view)
        assertEquals("2024-02-01", yearResult.state.anchorDate)
        val monthTarget = assertIs<CalendarNavigationTarget.Month>(yearResult.target)
        assertEquals("2024-02-01", monthTarget.anchorDate)

        val dayState = monthState.copy(view = CalendarView.DAY, anchorDate = "2026-01-01", selectedDate = "2026-01-01")
        assertEquals("2026-01-02", CalendarNavigation.next(dayState).anchorDate)
        val yearState = monthState.copy(view = CalendarView.YEAR, anchorDate = "2024-02-29", selectedDate = "2024-02-29")
        assertEquals("2025-02-28", CalendarNavigation.next(yearState).anchorDate)
    }

    private fun occurrence(
        id: String,
        title: String,
        start: String,
        end: String? = null,
        originalStart: String? = null,
        scope: CalendarScope = CalendarScope.HOUSEHOLD,
        importance: Importance = Importance.NORMAL,
        group: String? = null,
        tags: List<String> = emptyList(),
    ): CalendarProjectionOccurrence = CalendarProjectionOccurrence(
        eventId = id,
        occurrenceId = "$id-occurrence",
        originalStart = originalStart,
        recurring = originalStart != null,
        scope = scope,
        title = title,
        start = start,
        end = end,
        importance = importance,
        group = group,
        tags = tags,
    )
}
