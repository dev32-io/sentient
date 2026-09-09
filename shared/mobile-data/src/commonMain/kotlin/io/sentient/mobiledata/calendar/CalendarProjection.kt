package io.sentient.mobiledata.calendar

import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Weekday
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

/**
 * Pure, deterministic calendar projection over a complete authorized set.
 *
 * The function deliberately does not query, page, cache, or mutate. Callers
 * provide all authorized occurrences for the visible/cache window and the
 * explicit device locale/timezone. Facets are derived before filters are
 * applied, then the same filtered set feeds every view.
 */
object CalendarProjection {
    fun project(request: CalendarProjectionRequest): CalendarExperienceProjection {
        require(isCalendarDate(request.anchorDate)) { "Invalid anchor date: ${request.anchorDate}" }
        require(isCalendarDate(request.selectedDate)) { "Invalid selected date: ${request.selectedDate}" }
        require(isCalendarDate(request.todayDate)) { "Invalid today date: ${request.todayDate}" }

        val authorized = canonicalOccurrences(request.occurrences)
        val facets = deriveFacets(authorized, request.filters)
        val filtered = authorized.filter { request.filters.matches(it) }
        val zone = safeTimeZone(request.locale.timeZoneId)
        val events = filtered.map { projectEvent(it, request.locale, zone) }
            .sortedWith(calendarEventComparator())
        val interval = intervalFor(request.view, request.anchorDate, request.locale)
        val eventsByDate = buildVisibleDateIndex(events, interval)

        fun eventsFor(date: String): List<CalendarProjectedEvent> = eventsByDate[date].orEmpty()

        fun cell(date: String, outsideMonth: Boolean): CalendarDateCell =
            dateCell(
                date = date,
                events = eventsFor(date),
                selectedDate = request.selectedDate,
                todayDate = request.todayDate,
                outsideMonth = outsideMonth,
                locale = request.locale,
            )

        val dayProjection = if (request.view == CalendarView.DAY) {
            val date = request.anchorDate
            val dayEvents = eventsFor(date)
            CalendarDayProjection(
                date = date,
                events = dayEvents,
                agenda = listOf(
                    CalendarAgendaSection(
                        date = date,
                        events = dayEvents,
                        accessibilityLabel = dateLabel(date, request.locale),
                    ),
                ),
                isSelected = date == request.selectedDate,
                isToday = date == request.todayDate,
                accessibilityLabel = dayAccessibilityLabel(
                    date = date,
                    selected = date == request.selectedDate,
                    today = date == request.todayDate,
                    eventCount = dayEvents.size,
                    locale = request.locale,
                ),
            )
        } else {
            null
        }

        val weekProjection = if (request.view == CalendarView.WEEK) {
            val start = weekStart(request.anchorDate, request.locale.resolvedWeekStart)
            val dates = (0 until 7).map { addCalendarDays(start, it) }
            val days = dates.map { cell(it, outsideMonth = false) }
            CalendarWeekProjection(
                startDate = start,
                endDate = dates.last(),
                days = days,
                events = dates.flatMap(::eventsFor)
                    .distinctBy { it.actionIdentity }
                    .sortedWith(calendarEventComparator()),
                agenda = dates.map {
                    CalendarAgendaSection(
                        date = it,
                        events = eventsFor(it),
                        accessibilityLabel = dateLabel(it, request.locale),
                    )
                },
                weekdayLabels = weekdayLabels(request.locale.resolvedWeekStart, request.locale),
            )
        } else {
            null
        }

        val monthProjection = if (request.view == CalendarView.MONTH) {
            val anchor = parseCalendarDate(request.anchorDate)
            val monthStart = formatCalendarDate(DateParts(anchor.year, anchor.month, 1))
            val firstWeekday = calendarWeekday(monthStart)
            val offset = (weekdayNumber(firstWeekday) - weekdayNumber(request.locale.resolvedWeekStart) + 7) % 7
            val gridStart = addCalendarDays(monthStart, -offset)
            val cells = (0 until 42).map { index ->
                val date = addCalendarDays(gridStart, index)
                val parsed = parseCalendarDate(date)
                cell(date, outsideMonth = parsed.year != anchor.year || parsed.month != anchor.month)
            }
            val agenda = (0 until 4).map { addCalendarDays(request.anchorDate, it) }
                .mapNotNull { date ->
                    val dayEvents = eventsFor(date)
                    if (dayEvents.isEmpty()) null else CalendarAgendaSection(
                        date = date,
                        events = dayEvents,
                        accessibilityLabel = dateLabel(date, request.locale),
                    )
                }
            CalendarMonthProjection(
                year = anchor.year,
                month = anchor.month,
                gridStartDate = gridStart,
                gridEndDate = cells.last().date,
                cells = cells,
                weekdayLabels = weekdayLabels(request.locale.resolvedWeekStart, request.locale),
                agenda = agenda,
            )
        } else {
            null
        }

        val yearProjection = if (request.view == CalendarView.YEAR) {
            val year = parseCalendarDate(request.anchorDate).year
            CalendarYearProjection(
                year = year,
                months = (1..12).map { month ->
                    val days = (1..daysInCalendarMonth(year, month)).map { day ->
                        val date = formatCalendarDate(DateParts(year, month, day))
                        cell(date, outsideMonth = false)
                    }
                    val monthEvents = days.flatMap { it.events }
                        .distinctBy { it.actionIdentity }
                        .sortedWith(calendarEventComparator())
                    CalendarYearMonthSummary(
                        year = year,
                        month = month,
                        days = days,
                        events = monthEvents,
                        eventDates = days.filter { it.events.isNotEmpty() }.map { it.date },
                        accessibilityLabel = monthAccessibilityLabel(year, month, monthEvents.size, request.locale),
                    )
                },
            )
        } else {
            null
        }

        return CalendarExperienceProjection(
            view = request.view,
            anchorDate = request.anchorDate,
            selectedDate = request.selectedDate,
            todayDate = request.todayDate,
            locale = request.locale,
            filters = request.filters,
            interval = interval,
            authorizedOccurrences = authorized,
            filteredOccurrences = filtered,
            facets = facets,
            day = dayProjection,
            week = weekProjection,
            month = monthProjection,
            year = yearProjection,
        )
    }
}

/**
 * Return the exact half-open interval rendered by the selected view.  The
 * coordinator uses the same calculation as the pure projection so cache and
 * network windows cannot drift from what native clients display.
 */
fun calendarVisibleInterval(
    view: CalendarView,
    anchorDate: String,
    locale: CalendarLocale = CalendarLocale(),
): CalendarDateInterval {
    require(isCalendarDate(anchorDate)) { "Invalid anchor date: $anchorDate" }
    return intervalFor(view, anchorDate, locale)
}

/** Direct adapter for the authoritative SDK effective-occurrence list. */
fun projectCalendar(
    occurrences: Iterable<EffectiveOccurrence>,
    anchorDate: String,
    view: CalendarView = CalendarView.MONTH,
    selectedDate: String = anchorDate,
    todayDate: String = anchorDate,
    locale: CalendarLocale = CalendarLocale(),
    filters: CalendarFilters = CalendarFilters(),
): CalendarExperienceProjection = CalendarProjection.project(
    CalendarProjectionRequest(
        occurrences = occurrences.map(EffectiveOccurrence::toCalendarProjectionOccurrence),
        anchorDate = anchorDate,
        view = view,
        selectedDate = selectedDate,
        todayDate = todayDate,
        locale = locale,
        filters = filters,
    ),
)

/** Source-compatible adapter for pre-V2/shared repository CalendarEvent values. */
fun projectCalendarEvents(
    events: Iterable<io.sentient.mobilesdk.calendar.CalendarEvent>,
    anchorDate: String,
    view: CalendarView = CalendarView.MONTH,
    selectedDate: String = anchorDate,
    todayDate: String = anchorDate,
    locale: CalendarLocale = CalendarLocale(),
    filters: CalendarFilters = CalendarFilters(),
): CalendarExperienceProjection = CalendarProjection.project(
    CalendarProjectionRequest(
        occurrences = events.map(io.sentient.mobilesdk.calendar.CalendarEvent::toCalendarProjectionOccurrence),
        anchorDate = anchorDate,
        view = view,
        selectedDate = selectedDate,
        todayDate = todayDate,
        locale = locale,
        filters = filters,
    ),
)

/** Convenience adapter used by a coordinator holding presentation state. */
fun projectCalendarOccurrences(
    occurrences: Iterable<CalendarProjectionOccurrence>,
    state: CalendarExperienceState,
): CalendarExperienceProjection {
    val values = occurrences.toList()
    return projectCalendarOccurrences(values, state.toProjectionRequest(values))
}

/** Request-shaped overload for callers that already have explicit projection inputs. */
fun projectCalendarOccurrences(
    occurrences: Iterable<CalendarProjectionOccurrence>,
    request: CalendarProjectionRequest,
): CalendarExperienceProjection = CalendarProjection.project(
    request.copy(occurrences = occurrences.toList()),
)

/** Pure local filter seam for coordinators that need matching rows without a view. */
fun filterCalendarOccurrences(
    occurrences: Iterable<CalendarProjectionOccurrence>,
    filters: CalendarFilters = CalendarFilters(),
): List<CalendarProjectionOccurrence> = canonicalOccurrences(occurrences.toList()).filter { filters.matches(it) }

/** Facets are intentionally derived from the authorized unfiltered set. */
fun deriveCalendarFacetOptions(
    occurrences: Iterable<CalendarProjectionOccurrence>,
    selectedFilters: CalendarFilters = CalendarFilters(),
): CalendarFacetOptions = deriveFacets(canonicalOccurrences(occurrences.toList()), selectedFilters)

private fun projectEvent(
    occurrence: CalendarProjectionOccurrence,
    locale: CalendarLocale,
    zone: TimeZone,
): CalendarProjectedEvent {
    val start = projectTime(occurrence.start, occurrence.persistedTimeZoneId, locale, zone)
    val end = occurrence.end?.let { projectTime(it, occurrence.persistedTimeZoneId, locale, zone) }
    val dateRange = eventDateRange(occurrence.start, occurrence.end, start, end, zone)
    val title = occurrence.title.ifBlank { "Untitled event" }
    val timeLabel = when (start) {
        is CalendarProjectedTime.AllDay -> "all day"
        is CalendarProjectedTime.Timed -> start.displayTime
    }
    return CalendarProjectedEvent(
        occurrence = occurrence,
        start = start,
        end = end,
        dateRange = dateRange,
        accessibilityLabel = "$title, ${dateLabel(start.date, locale)}, $timeLabel",
    )
}

private fun projectTime(
    raw: String,
    persistedTimeZoneId: String?,
    locale: CalendarLocale,
    zone: TimeZone,
): CalendarProjectedTime {
    if (isCalendarDate(raw)) return CalendarProjectedTime.AllDay(raw)

    val instant = parseInstant(raw)
    val local = instant.toLocalDateTime(zone)
    val date = local.date.toString()
    val localTime = "${twoDigits(local.hour)}:${twoDigits(local.minute)}"
    return CalendarProjectedTime.Timed(
        rawValue = raw,
        instant = raw,
        date = date,
        localTime = localTime,
        displayTime = formatDisplayTime(local.hour, local.minute, locale),
        persistedTimeZoneId = persistedTimeZoneId,
    )
}

private fun eventDateRange(
    rawStart: String,
    rawEnd: String?,
    start: CalendarProjectedTime,
    end: CalendarProjectedTime?,
    zone: TimeZone,
): CalendarDateInterval {
    if (start is CalendarProjectedTime.AllDay) {
        val endDate = if (rawEnd != null && isCalendarDate(rawEnd)) rawEnd else addCalendarDays(start.date, 1)
        val safeEnd = if (compareCalendarDates(endDate, start.date) <= 0) addCalendarDays(start.date, 1) else endDate
        return CalendarDateInterval(start.date, safeEnd)
    }

    val startTimed = start as CalendarProjectedTime.Timed
    val startInstant = parseInstant(rawStart)
    val endInstant = rawEnd?.takeUnless(::isCalendarDate)?.let(::parseInstant)
    if (endInstant == null || endInstant <= startInstant || end !is CalendarProjectedTime.Timed) {
        return CalendarDateInterval(startTimed.date, addCalendarDays(startTimed.date, 1))
    }

    val endLocal = endInstant.toLocalDateTime(zone)
    val endDate = endLocal.date.toString()
    val endsAtLocalMidnight = endLocal.hour == 0 && endLocal.minute == 0 && endLocal.second == 0 && endLocal.nanosecond == 0
    val endExclusive = if (endsAtLocalMidnight) endDate else addCalendarDays(endDate, 1)
    val safeEnd = if (compareCalendarDates(endExclusive, startTimed.date) <= 0) {
        addCalendarDays(startTimed.date, 1)
    } else {
        endExclusive
    }
    return CalendarDateInterval(startTimed.date, safeEnd)
}

private fun buildVisibleDateIndex(
    events: List<CalendarProjectedEvent>,
    visibleInterval: CalendarDateInterval,
): Map<String, List<CalendarProjectedEvent>> {
    val byDate = mutableMapOf<String, MutableList<CalendarProjectedEvent>>()
    events.forEach { event ->
        var date = if (compareCalendarDates(event.dateRange.startDate, visibleInterval.startDate) < 0) {
            visibleInterval.startDate
        } else {
            event.dateRange.startDate
        }
        val endExclusive = if (compareCalendarDates(event.dateRange.endExclusive, visibleInterval.endExclusive) > 0) {
            visibleInterval.endExclusive
        } else {
            event.dateRange.endExclusive
        }
        while (compareCalendarDates(date, endExclusive) < 0) {
            byDate.getOrPut(date) { mutableListOf() }.add(event)
            date = addCalendarDays(date, 1)
        }
    }
    return byDate
}

private fun dateCell(
    date: String,
    events: List<CalendarProjectedEvent>,
    selectedDate: String,
    todayDate: String,
    outsideMonth: Boolean,
    locale: CalendarLocale,
): CalendarDateCell {
    val parsed = parseCalendarDate(date)
    val indicators = events.take(3).map { event ->
        CalendarEventIndicator(
            actionIdentity = event.actionIdentity,
            kind = event.kind,
            title = event.title,
            accessibilityLabel = event.accessibilityLabel,
        )
    }
    val overflow = (events.size - indicators.size).takeIf { it > 0 }?.let { count ->
        val noun = if (count == 1) "event" else "events"
        CalendarOverflow(
            count = count,
            label = "+$count more",
            accessibilityLabel = "+$count more $noun on ${dateLabel(date, locale)}",
        )
    }
    return CalendarDateCell(
        date = date,
        dayOfMonth = parsed.day,
        events = events,
        indicators = indicators,
        overflow = overflow,
        isSelected = date == selectedDate,
        isToday = date == todayDate,
        isOutsideMonth = outsideMonth,
        accessibilityLabel = dayAccessibilityLabel(
            date = date,
            selected = date == selectedDate,
            today = date == todayDate,
            outsideMonth = outsideMonth,
            eventCount = events.size,
            locale = locale,
        ),
    )
}

private fun dayAccessibilityLabel(
    date: String,
    selected: Boolean,
    today: Boolean,
    eventCount: Int,
    locale: CalendarLocale,
    outsideMonth: Boolean = false,
): String = buildString {
    append(dateLabel(date, locale))
    if (today) append(", today")
    if (selected) append(", selected")
    if (outsideMonth) append(", outside month")
    if (eventCount > 0) {
        append(", ")
        append(eventCount)
        append(if (eventCount == 1) " event" else " events")
    }
}

private fun monthAccessibilityLabel(year: Int, month: Int, eventCount: Int, locale: CalendarLocale): String =
    buildString {
        append(monthName(month, locale))
        append(' ')
        append(year)
        if (eventCount > 0) {
            append(", ")
            append(eventCount)
            append(if (eventCount == 1) " event" else " events")
        }
    }

private fun intervalFor(view: CalendarView, anchorDate: String, locale: CalendarLocale): CalendarDateInterval {
    val anchor = parseCalendarDate(anchorDate)
    return when (view) {
        CalendarView.DAY -> CalendarDateInterval(anchorDate, addCalendarDays(anchorDate, 1))
        CalendarView.WEEK -> {
            val start = weekStart(anchorDate, locale.resolvedWeekStart)
            CalendarDateInterval(start, addCalendarDays(start, 7))
        }
        CalendarView.MONTH -> {
            val monthStart = formatCalendarDate(DateParts(anchor.year, anchor.month, 1))
            val offset = (weekdayNumber(calendarWeekday(monthStart)) - weekdayNumber(locale.resolvedWeekStart) + 7) % 7
            val gridStart = addCalendarDays(monthStart, -offset)
            CalendarDateInterval(gridStart, addCalendarDays(gridStart, 42))
        }
        CalendarView.YEAR -> {
            val yearStart = formatCalendarDate(DateParts(anchor.year, 1, 1))
            CalendarDateInterval(yearStart, formatCalendarDate(DateParts(anchor.year + 1, 1, 1)))
        }
    }
}

private fun weekStart(anchorDate: String, start: Weekday): String {
    val day = calendarWeekday(anchorDate)
    val offset = (weekdayNumber(day) - weekdayNumber(start) + 7) % 7
    return addCalendarDays(anchorDate, -offset)
}

private fun weekdayLabels(start: Weekday, locale: CalendarLocale): List<CalendarWeekdayLabel> =
    (0 until 7).map { offset ->
        val weekday = weekdayFromNumber(((weekdayNumber(start) - 1 + offset) % 7) + 1)
        CalendarWeekdayLabel(
            weekday = weekday,
            shortLabel = shortWeekdayName(weekday, locale),
            accessibilityLabel = fullWeekdayName(weekday, locale),
        )
    }

private fun deriveFacets(
    occurrences: List<CalendarProjectionOccurrence>,
    filters: CalendarFilters,
): CalendarFacetOptions {
    val actualScopes = occurrences.map { it.scope }.toSet()
    val scopeValues = buildList {
        // ALL is the aggregate selector, not a disclosure of an event row.
        add(CalendarScope.ALL)
        if (CalendarScope.PRIVATE in actualScopes || filters.scope == CalendarScope.PRIVATE) add(CalendarScope.PRIVATE)
        if (CalendarScope.HOUSEHOLD in actualScopes || filters.scope == CalendarScope.HOUSEHOLD) add(CalendarScope.HOUSEHOLD)
    }
    val groups = sortedFacetValues(occurrences.mapNotNull { it.group } + filters.groups)
    val tags = sortedFacetValues(occurrences.flatMap { it.tags } + filters.tags)
    val importances = buildList {
        occurrences.map { it.importance }.toSet().forEach { add(it) }
        filters.importance?.let { selected -> if (selected !in this) add(selected) }
    }.sortedBy { it.ordinal }
    return CalendarFacetOptions(scopeValues, groups, tags, importances)
}

private fun sortedFacetValues(values: Iterable<String>): List<String> = values
    .map(String::trim)
    .filter(String::isNotEmpty)
    .distinctBy(::facetKey)
    .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it })

private fun canonicalOccurrences(values: List<CalendarProjectionOccurrence>): List<CalendarProjectionOccurrence> =
    values.groupBy { it.actionIdentity }
        .values
        .map { duplicates ->
            duplicates.sortedWith(
                compareByDescending<CalendarProjectionOccurrence> { it.revision }
                    .thenBy { it.start }
                    .thenBy { it.title }
                    .thenBy { it.eventId },
            ).first()
        }
        .sortedWith(compareBy<CalendarProjectionOccurrence> { it.start }.thenBy { it.eventId }.thenBy { it.occurrenceId })

private fun CalendarFilters.matches(occurrence: CalendarProjectionOccurrence): Boolean {
    if (scope != CalendarScope.ALL && occurrence.scope != scope) return false
    if (groups.isNotEmpty() && occurrence.group?.let(::facetKey)?.let { key -> groups.any { facetKey(it) == key } } != true) return false
    if (tags.isNotEmpty() && tags.any { selected -> occurrence.tags.none { facetKey(it) == facetKey(selected) } }) return false
    if (importance != null && occurrence.importance != importance) return false
    val query = text.trim().lowercase()
    if (query.isNotEmpty()) {
        // Keep local search equivalent to the V2 query contract: title and
        // description are searchable; facet metadata has its own filters.
        val searchable = (occurrence.title + "\u0000" + occurrence.description.orEmpty()).lowercase()
        if (!searchable.contains(query)) return false
    }
    return true
}

private fun facetKey(value: String): String = value.trim().lowercase()

internal fun calendarEventComparator(): Comparator<CalendarProjectedEvent> =
    compareBy<CalendarProjectedEvent>({ if (it.isAllDay) 0 else 1 })
        .thenBy { it.start.date }
        .thenBy { (it.start as? CalendarProjectedTime.Timed)?.localTime.orEmpty() }
        .thenBy { it.title.lowercase() }
        .thenBy { it.actionIdentity.stableKey }

private fun parseInstant(raw: String): Instant = try {
    parseCalendarInstant(raw)
} catch (error: IllegalArgumentException) {
    throw IllegalArgumentException("Invalid timed calendar value: $raw", error)
}

private fun safeTimeZone(id: String): TimeZone = try {
    TimeZone.of(id)
} catch (_: IllegalArgumentException) {
    TimeZone.UTC
}

private fun formatDisplayTime(hour: Int, minute: Int, locale: CalendarLocale): String {
    val use12 = when (locale.hourCycle) {
        CalendarHourCycle.HOUR12 -> true
        CalendarHourCycle.HOUR24 -> false
        CalendarHourCycle.LOCALE -> localeUses12HourClock(locale.languageTag)
    }
    return if (!use12) {
        "${twoDigits(hour)}:${twoDigits(minute)}"
    } else {
        val suffix = if (hour < 12) "AM" else "PM"
        val displayHour = when (val h = hour % 12) {
            0 -> 12
            else -> h
        }
        "$displayHour:${twoDigits(minute)} $suffix"
    }
}

private fun twoDigits(value: Int): String = value.toString().padStart(2, '0')

private fun localeUses12HourClock(languageTag: String): Boolean {
    val normalized = languageTag.replace('_', '-')
    val region = normalized.substringAfter('-', "").uppercase()
    return region in setOf("US", "CA", "AU", "NZ", "PH", "IN", "EG")
}

private val EN_WEEKDAYS = mapOf(
    Weekday.MONDAY to "Mon",
    Weekday.TUESDAY to "Tue",
    Weekday.WEDNESDAY to "Wed",
    Weekday.THURSDAY to "Thu",
    Weekday.FRIDAY to "Fri",
    Weekday.SATURDAY to "Sat",
    Weekday.SUNDAY to "Sun",
)

private val DE_WEEKDAYS = mapOf(
    Weekday.MONDAY to "Mo",
    Weekday.TUESDAY to "Di",
    Weekday.WEDNESDAY to "Mi",
    Weekday.THURSDAY to "Do",
    Weekday.FRIDAY to "Fr",
    Weekday.SATURDAY to "Sa",
    Weekday.SUNDAY to "So",
)

private val FR_WEEKDAYS = mapOf(
    Weekday.MONDAY to "lun.",
    Weekday.TUESDAY to "mar.",
    Weekday.WEDNESDAY to "mer.",
    Weekday.THURSDAY to "jeu.",
    Weekday.FRIDAY to "ven.",
    Weekday.SATURDAY to "sam.",
    Weekday.SUNDAY to "dim.",
)

private val EN_MONTHS = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
private val DE_MONTHS = listOf(
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
)
private val FR_MONTHS = listOf(
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
)

private fun languageOf(locale: CalendarLocale): String = locale.languageTag.substringBefore('-', locale.languageTag).lowercase()

private fun shortWeekdayName(day: Weekday, locale: CalendarLocale): String = when (languageOf(locale)) {
    "de" -> DE_WEEKDAYS.getValue(day)
    "fr" -> FR_WEEKDAYS.getValue(day)
    else -> EN_WEEKDAYS.getValue(day)
}

private fun fullWeekdayName(day: Weekday, locale: CalendarLocale): String = when (languageOf(locale)) {
    "de" -> mapOf(
        Weekday.MONDAY to "Montag", Weekday.TUESDAY to "Dienstag", Weekday.WEDNESDAY to "Mittwoch",
        Weekday.THURSDAY to "Donnerstag", Weekday.FRIDAY to "Freitag", Weekday.SATURDAY to "Samstag",
        Weekday.SUNDAY to "Sonntag",
    ).getValue(day)
    "fr" -> mapOf(
        Weekday.MONDAY to "lundi", Weekday.TUESDAY to "mardi", Weekday.WEDNESDAY to "mercredi",
        Weekday.THURSDAY to "jeudi", Weekday.FRIDAY to "vendredi", Weekday.SATURDAY to "samedi",
        Weekday.SUNDAY to "dimanche",
    ).getValue(day)
    else -> mapOf(
        Weekday.MONDAY to "Monday", Weekday.TUESDAY to "Tuesday", Weekday.WEDNESDAY to "Wednesday",
        Weekday.THURSDAY to "Thursday", Weekday.FRIDAY to "Friday", Weekday.SATURDAY to "Saturday",
        Weekday.SUNDAY to "Sunday",
    ).getValue(day)
}

private fun monthName(month: Int, locale: CalendarLocale): String = when (languageOf(locale)) {
    "de" -> DE_MONTHS[month - 1]
    "fr" -> FR_MONTHS[month - 1]
    else -> EN_MONTHS[month - 1]
}

private fun dateLabel(date: String, locale: CalendarLocale): String {
    val parsed = parseCalendarDate(date)
    val weekday = fullWeekdayName(calendarWeekday(date), locale)
    val month = monthName(parsed.month, locale)
    return when (languageOf(locale)) {
        "de" -> "$weekday, ${parsed.day}. $month ${parsed.year}"
        "fr" -> "$weekday ${parsed.day} $month ${parsed.year}"
        else -> "$weekday, $month ${parsed.day}, ${parsed.year}"
    }
}
