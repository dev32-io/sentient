package io.sentient.android.settings.calendar

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.SentientTheme
import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.calendar.CalendarAgendaSection
import io.sentient.mobiledata.calendar.CalendarDateCell
import io.sentient.mobiledata.calendar.CalendarDateInterval
import io.sentient.mobiledata.calendar.CalendarDayProjection
import io.sentient.mobiledata.calendar.CalendarEventActionIdentity
import io.sentient.mobiledata.calendar.CalendarEventIndicator
import io.sentient.mobiledata.calendar.CalendarEventKind
import io.sentient.mobiledata.calendar.CalendarExperienceError
import io.sentient.mobiledata.calendar.CalendarExperienceErrorKind
import io.sentient.mobiledata.calendar.CalendarFacetOptions
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarLoadingState
import io.sentient.mobiledata.calendar.CalendarMonthProjection
import io.sentient.mobiledata.calendar.CalendarMutationAvailability
import io.sentient.mobiledata.calendar.CalendarMutationPhase
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobiledata.calendar.CalendarProjectedEvent
import io.sentient.mobiledata.calendar.CalendarProjectedTime
import io.sentient.mobiledata.calendar.CalendarProjectionOccurrence
import io.sentient.mobiledata.calendar.CalendarWeekProjection
import io.sentient.mobiledata.calendar.CalendarWeekdayLabel
import io.sentient.mobiledata.calendar.CalendarYearMonthSummary
import io.sentient.mobiledata.calendar.CalendarYearProjection
import io.sentient.mobiledata.calendar.CalendarLocale
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.calendar.Weekday
import java.time.LocalDate
import java.time.YearMonth

/*
 * Direct handoff comparison: 390x844 and 430x932 mirror calendar.html. Corrections are
 * limited to complete real Year dates, 44dp tag hit areas, system-inset clearance,
 * controlled live state and accessibility semantics.
 */
@Preview(name = "Day · 390x844", widthDp = 390, heightDp = 844)
@Preview(name = "Day · 430x932", widthDp = 430, heightDp = 932)
@Composable
private fun CalendarDaySizePreviews() = CalendarPreview(CalendarView.DAY)

@Preview(name = "Week · 390x844", widthDp = 390, heightDp = 844)
@Preview(name = "Week · 430x932", widthDp = 430, heightDp = 932)
@Composable
private fun CalendarWeekSizePreviews() = CalendarPreview(CalendarView.WEEK)

@Preview(name = "Month · 390x844", widthDp = 390, heightDp = 844)
@Preview(name = "Month · 430x932", widthDp = 430, heightDp = 932)
@Composable
private fun CalendarMonthSizePreviews() = CalendarPreview(CalendarView.MONTH)

@Preview(name = "Year · 390x844", widthDp = 390, heightDp = 844)
@Preview(name = "Year · 430x932", widthDp = 430, heightDp = 932)
@Composable
private fun CalendarYearSizePreviews() = CalendarPreview(CalendarView.YEAR)

@Preview(name = "Dense month", widthDp = 390, heightDp = 844)
@Composable
private fun CalendarDensePreview() = CalendarPreview(CalendarView.MONTH)

@Preview(name = "Empty", widthDp = 390, heightDp = 844)
@Composable
private fun CalendarEmptyPreview() = CalendarPreview(CalendarView.DAY, CalendarContentState.EMPTY)

@Preview(name = "Offline cache", widthDp = 390, heightDp = 844)
@Composable
private fun CalendarOfflinePreview() = CalendarPreview(CalendarView.WEEK, offline = true)

@Preview(name = "Error", widthDp = 390, heightDp = 844)
@Composable
private fun CalendarErrorPreview() = CalendarPreview(CalendarView.MONTH, CalendarContentState.ERROR)

@Preview(name = "Large font", widthDp = 430, heightDp = 932, fontScale = 1.6f)
@Composable
private fun CalendarFontScalePreview() = CalendarPreview(CalendarView.DAY)

@Composable
private fun CalendarPreview(
    view: CalendarView,
    contentState: CalendarContentState = CalendarContentState.CONTENT,
    offline: Boolean = false,
) {
    val state = previewState(view, contentState, offline)
    SentientTheme {
        CalendarScaffold(
            state = state,
            title = when (view) {
                CalendarView.DAY -> "April 18"
                CalendarView.WEEK -> "Apr 12–18"
                CalendarView.MONTH -> "April 2026"
                CalendarView.YEAR -> "2026"
            },
            subtitle = if (view == CalendarView.YEAR) "Year at a glance" else "Saturday · 18",
            callbacks = previewCallbacks,
        )
    }
}

private val previewCallbacks = CalendarSurfaceCallbacks(
    onBack = {}, onAdd = {}, onToday = {}, onPrevious = {}, onNext = {},
    onDateSelected = {}, onMonthSelected = { _, _ -> }, onViewSelected = {},
    onScopeSelected = {}, onGroupToggled = {}, onTagToggled = {},
    onImportanceSelected = {}, onSearchChanged = {}, onEventSelected = {}, onRetry = {},
)

private fun previewState(view: CalendarView, contentState: CalendarContentState, offline: Boolean): CalendarUiState {
    val event = previewEvent()
    val month = previewMonth(event)
    val weekDays = (12..18).map { day -> previewCell("2026-04-$day", day, event.takeIf { day == 18 }) }
    val labels = Weekday.entries.map { CalendarWeekdayLabel(it, it.name.first().toString(), it.name.lowercase()) }
    val agenda = listOf(CalendarAgendaSection("2026-04-18", listOf(event), "Saturday, April 18"))
    return CalendarUiState(
        anchorDate = "2026-04-18",
        selectedDate = "2026-04-18",
        todayDate = "2026-04-18",
        view = view,
        locale = CalendarLocale(),
        filters = CalendarFilters(tags = setOf("family")),
        visibleInterval = CalendarDateInterval("2026-04-01", "2026-05-01"),
        selectedInterval = CalendarDateInterval("2026-04-18", "2026-04-19"),
        day = CalendarDayProjection("2026-04-18", listOf(event), agenda, true, true, "Saturday, April 18, selected, today"),
        week = CalendarWeekProjection("2026-04-12", "2026-04-18", weekDays, listOf(event), agenda, labels),
        month = month,
        year = previewYear(event),
        facets = CalendarFacetOptions(
            scopes = CalendarScope.entries,
            groups = listOf("Family"),
            tags = listOf("family", "school", "routine", "travel"),
            importances = Importance.entries,
        ),
        authorizedOccurrences = emptyList(),
        agendaRows = if (contentState == CalendarContentState.CONTENT) agenda else emptyList(),
        visibleEvents = if (contentState == CalendarContentState.CONTENT) listOf(event) else emptyList(),
        freshness = if (offline) CalendarCacheFreshness.CACHED_OFFLINE else CalendarCacheFreshness.FRESH,
        offline = if (offline) CalendarOfflineState.OFFLINE else CalendarOfflineState.ONLINE,
        loading = CalendarLoadingState(),
        hasCompleteCache = true,
        contentState = contentState,
        error = if (contentState == CalendarContentState.ERROR) CalendarExperienceError(CalendarExperienceErrorKind.CONNECTION, "Calendar could not be refreshed") else null,
        mutationAvailability = CalendarMutationAvailability(canCreate = !offline, canEdit = !offline, canDelete = !offline),
        mutationPhase = CalendarMutationPhase.IDLE,
        preview = null,
        editor = null,
        deleteConfirmation = null,
        conflict = null,
        mutationError = null,
        outcome = null,
    )
}

private fun previewEvent(): CalendarProjectedEvent {
    val occurrence = CalendarProjectionOccurrence(
        eventId = "birthday",
        occurrenceId = "birthday-2026",
        scope = CalendarScope.HOUSEHOLD,
        title = "Mia’s birthday planning",
        start = "2026-04-18T10:30:00Z",
        end = "2026-04-18T11:30:00Z",
        visibility = Visibility.EVERYONE,
        importance = Importance.IMPORTANT,
        group = "Family",
        tags = listOf("family"),
    )
    return CalendarProjectedEvent(
        occurrence = occurrence,
        start = CalendarProjectedTime.Timed(occurrence.start, occurrence.start, "2026-04-18", "10:30", "10:30 AM"),
        end = null,
        dateRange = CalendarDateInterval("2026-04-18", "2026-04-19"),
        accessibilityLabel = "Mia’s birthday planning, 10:30 AM, household",
    )
}

private fun previewMonth(event: CalendarProjectedEvent): CalendarMonthProjection {
    val start = LocalDate.of(2026, 3, 29)
    val cells = (0 until 42).map { offset ->
        val date = start.plusDays(offset.toLong())
        previewCell(date.toString(), date.dayOfMonth, event.takeIf { date.toString() == "2026-04-18" }, date.monthValue != 4)
    }
    val labels = Weekday.entries.map { CalendarWeekdayLabel(it, it.name.first().toString(), it.name.lowercase()) }
    return CalendarMonthProjection(2026, 4, cells.first().date, cells.last().date, cells, labels)
}

private fun previewYear(event: CalendarProjectedEvent): CalendarYearProjection = CalendarYearProjection(
    2026,
    (1..12).map { month ->
        val days = (1..YearMonth.of(2026, month).lengthOfMonth()).map { day ->
            val date = "2026-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"
            previewCell(date, day, event.takeIf { date == "2026-04-18" })
        }
        CalendarYearMonthSummary(
            2026, month, days,
            events = if (month == 4) listOf(event) else emptyList(),
            eventDates = if (month == 4) listOf("2026-04-18") else emptyList(),
            accessibilityLabel = "${YearMonth.of(2026, month).month.name.lowercase()} 2026",
        )
    },
)

private fun previewCell(date: String, day: Int, event: CalendarProjectedEvent?, outside: Boolean = false): CalendarDateCell {
    val identity = CalendarEventActionIdentity("birthday", "birthday-2026", null, CalendarScope.HOUSEHOLD)
    return CalendarDateCell(
        date = date,
        dayOfMonth = day,
        events = listOfNotNull(event),
        indicators = if (event == null) emptyList() else listOf(CalendarEventIndicator(identity, CalendarEventKind.TIMED, event.title, event.accessibilityLabel)),
        overflow = null,
        isSelected = date == "2026-04-18",
        isToday = date == "2026-04-18",
        isOutsideMonth = outside,
        accessibilityLabel = "$date${if (event == null) "" else ", 1 event"}",
    )
}
