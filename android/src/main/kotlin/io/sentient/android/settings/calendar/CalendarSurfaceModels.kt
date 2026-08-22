package io.sentient.android.settings.calendar

import io.sentient.mobiledata.calendar.CalendarFacetOptions
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarFreshness
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.CalendarYearProjection
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Geometry pinned by the reviewed mobile calendar handoff. */
object CalendarSurfaceLayout {
    const val TOP_BAR_DP = 58
    const val HORIZONTAL_INSET_DP = 16
    const val MIN_TARGET_DP = 44
    const val TAG_VISUAL_DP = 34
    const val MONTH_CELL_COUNT = 42
    const val WEEK_DAY_COUNT = 7
    const val YEAR_MONTH_COUNT = 12
    const val AGENDA_ROW_DP = 64
    const val VIEW_CONTROL_DP = 46
    const val FLOATING_BAR_SIDE_INSET_DP = 12
    const val FLOATING_BAR_BOTTOM_GAP_DP = 8
    const val SCROLL_BOTTOM_CLEARANCE_DP = 82
}

/** Day is the focused agenda presentation and therefore has no separate compact canvas. */
fun calendarShowsCompactCanvas(view: CalendarView): Boolean = view != CalendarView.DAY

data class RetainedCalendarFacets(
    val groups: List<String>,
    val tags: List<String>,
)

/** Keeps selected stale facets visible so every active filter remains removable. */
fun retainedCalendarFacets(filters: CalendarFilters, facets: CalendarFacetOptions): RetainedCalendarFacets =
    RetainedCalendarFacets(
        groups = retainSelected(facets.groups, filters.groups),
        tags = retainSelected(facets.tags, filters.tags),
    )

private fun retainSelected(available: List<String>, selected: Set<String>): List<String> =
    (available + selected.sorted()).distinct()

fun fullCalendarDateLabel(date: String, languageTag: String): String {
    val locale = Locale.forLanguageTag(languageTag)
    return LocalDate.parse(date).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale))
}

fun calendarMonthTitle(year: Int, month: Int, languageTag: String): String =
    YearMonth.of(year, month).format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.forLanguageTag(languageTag)))

fun calendarMonthShortName(year: Int, month: Int, languageTag: String): String =
    YearMonth.of(year, month).format(DateTimeFormatter.ofPattern("MMM", Locale.forLanguageTag(languageTag)))

/** Rejects prototype-style 28-day summaries; every real date in all twelve months must be present. */
fun isCompleteYearProjection(year: CalendarYearProjection): Boolean =
    year.months.size == CalendarSurfaceLayout.YEAR_MONTH_COUNT &&
        year.months.withIndex().all { (index, month) ->
            month.year == year.year &&
                month.month == index + 1 &&
                month.days.size == YearMonth.of(month.year, month.month).lengthOfMonth()
        }

fun expectedCalendarYearDayCount(year: Int): Int =
    (1..12).sumOf { YearMonth.of(year, it).lengthOfMonth() }

fun calendarViewAccessibilityLabel(view: CalendarView, selected: Boolean): String =
    "${view.name.lowercase().replaceFirstChar { it.titlecase() }} view" + if (selected) ", selected" else ""

fun calendarOverflowAccessibilityLabel(dateLabel: String, count: Int): String =
    "$count more ${if (count == 1) "event" else "events"} on $dateLabel"

fun calendarFreshnessDescription(state: CalendarUiState): String = when {
    state.offline == CalendarOfflineState.UNAVAILABLE -> "Unavailable offline"
    state.offline == CalendarOfflineState.OFFLINE -> "Offline, showing saved calendar"
    state.isRefreshing -> "Refreshing"
    state.freshness == CalendarFreshness.STALE -> "May be out of date"
    else -> "Up to date"
}

fun calendarFreshnessTag(state: CalendarUiState): String = when {
    state.offline == CalendarOfflineState.UNAVAILABLE -> CalendarTestTags.FRESHNESS_UNAVAILABLE
    state.offline == CalendarOfflineState.OFFLINE -> CalendarTestTags.FRESHNESS_OFFLINE
    state.isRefreshing -> CalendarTestTags.FRESHNESS_REFRESHING
    state.freshness == CalendarFreshness.STALE -> CalendarTestTags.FRESHNESS_STALE
    else -> CalendarTestTags.FRESHNESS_UP_TO_DATE
}
