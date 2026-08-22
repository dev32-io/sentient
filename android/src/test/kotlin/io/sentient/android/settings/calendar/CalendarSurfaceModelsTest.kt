package io.sentient.android.settings.calendar

import io.sentient.mobiledata.calendar.CalendarDateCell
import io.sentient.mobiledata.calendar.CalendarFacetOptions
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.CalendarYearMonthSummary
import io.sentient.mobiledata.calendar.CalendarYearProjection
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
import java.time.YearMonth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CalendarSurfaceModelsTest {
    @Test
    fun `month selection requests day while week selection retains week`() {
        assertEquals(
            CalendarDateSelection("2026-04-18", CalendarView.DAY),
            calendarDateSelection(CalendarView.MONTH, "2026-04-18"),
        )
        assertEquals(
            CalendarDateSelection("2026-04-18", CalendarView.WEEK),
            calendarDateSelection(CalendarView.WEEK, "2026-04-18"),
        )
    }

    @Test
    fun `selected absent facets remain visible and removable`() {
        val retained = retainedCalendarFacets(
            filters = CalendarFilters(groups = setOf("Archived"), tags = setOf("travel")),
            facets = CalendarFacetOptions(
                scopes = listOf(CalendarScope.ALL, CalendarScope.PRIVATE, CalendarScope.HOUSEHOLD),
                groups = listOf("Family"),
                tags = listOf("school"),
                importances = listOf(Importance.NORMAL),
            ),
        )

        assertEquals(listOf("Family", "Archived"), retained.groups)
        assertEquals(listOf("school", "travel"), retained.tags)
    }

    @Test
    fun `accessibility label builders expose selection date and overflow state`() {
        assertEquals("Month view, selected", calendarViewAccessibilityLabel(CalendarView.MONTH, true))
        assertEquals("Week view", calendarViewAccessibilityLabel(CalendarView.WEEK, false))
        assertEquals("2 more events on Saturday, April 18", calendarOverflowAccessibilityLabel("Saturday, April 18", 2))
        assertEquals("Saturday, April 18, 2026", fullCalendarDateLabel("2026-04-18", "en-US"))
    }

    @Test
    fun `complete year accepts every real date and rejects 28-day prototype summaries`() {
        assertTrue(isCompleteYearProjection(yearProjection(2028, complete = true)))
        assertFalse(isCompleteYearProjection(yearProjection(2028, complete = false)))
        assertEquals(366, expectedCalendarYearDayCount(2028))
        assertEquals(365, expectedCalendarYearDayCount(2027))
    }

    @Test
    fun `reviewed calendar geometry remains pinned`() {
        assertEquals(58, CalendarSurfaceLayout.TOP_BAR_DP)
        assertEquals(16, CalendarSurfaceLayout.HORIZONTAL_INSET_DP)
        assertEquals(44, CalendarSurfaceLayout.MIN_TARGET_DP)
        assertEquals(34, CalendarSurfaceLayout.TAG_VISUAL_DP)
        assertEquals(46, CalendarSurfaceLayout.VIEW_CONTROL_DP)
        assertEquals(64, CalendarSurfaceLayout.AGENDA_ROW_DP)
        assertEquals(42, CalendarSurfaceLayout.MONTH_CELL_COUNT)
        assertEquals(7, CalendarSurfaceLayout.WEEK_DAY_COUNT)
        assertEquals(12, CalendarSurfaceLayout.YEAR_MONTH_COUNT)
        assertTrue(CalendarSurfaceLayout.SCROLL_BOTTOM_CLEARANCE_DP > CalendarSurfaceLayout.VIEW_CONTROL_DP)
    }

    private fun yearProjection(year: Int, complete: Boolean): CalendarYearProjection = CalendarYearProjection(
        year,
        (1..12).map { month ->
            val dayCount = if (complete) YearMonth.of(year, month).lengthOfMonth() else 28
            CalendarYearMonthSummary(
                year = year,
                month = month,
                days = (1..dayCount).map { day -> emptyCell(year, month, day) },
                events = emptyList(),
                eventDates = emptyList(),
                accessibilityLabel = "$year-$month",
            )
        },
    )

    private fun emptyCell(year: Int, month: Int, day: Int) = CalendarDateCell(
        date = "%04d-%02d-%02d".format(year, month, day),
        dayOfMonth = day,
        events = emptyList(),
        indicators = emptyList(),
        overflow = null,
        isSelected = false,
        isToday = false,
        isOutsideMonth = false,
        accessibilityLabel = "$year-$month-$day",
    )
}
