package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.calendar.Weekday
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CALENDAR_WIRE_TIME_ZONE

/** The four calendar views shared by the native clients. */
enum class CalendarView {
    DAY,
    WEEK,
    MONTH,
    YEAR,
}

typealias CalendarViewMode = CalendarView
typealias CalendarWeekStart = Weekday

/** The hour-cycle choices accepted by the platform-neutral formatter. */
enum class CalendarHourCycle {
    LOCALE,
    HOUR12,
    HOUR24,
}

/**
 * Explicit formatting inputs supplied by the device/session.
 *
 * A named timezone is intentionally an input rather than something inferred
 * from an occurrence. The raw event values remain untouched in every
 * projection; this zone is used only to derive the local date and clock label
 * shown by the device.
 */
data class CalendarLocale(
    val languageTag: String = "en-US",
    val timeZoneId: String = "UTC",
    val weekStart: Weekday? = null,
    val hourCycle: CalendarHourCycle = CalendarHourCycle.LOCALE,
) {
    val resolvedWeekStart: Weekday
        get() = weekStart ?: defaultWeekStartForLocale(languageTag)
}

/**
 * Supported local calendar filters. Groups are ORed when several are selected;
 * every selected tag must be present (matching the current Calendar V2 query
 * contract); different facets are intersected. Empty groups/tags and a null
 * importance mean that facet is inactive. [CalendarScope.ALL] means no scope
 * restriction.
 */
data class CalendarFilters(
    val scope: CalendarScope = CalendarScope.ALL,
    val groups: Set<String> = emptySet(),
    val tags: Set<String> = emptySet(),
    val importance: Importance? = null,
    val text: String = "",
) {
    /** Source-friendly aliases for callers that name the text facet query. */
    val query: String get() = text
    val searchText: String get() = text
}

typealias CalendarFilter = CalendarFilters

/**
 * Facets are derived from the complete authorized, unfiltered occurrence set.
 * Selected values are retained in these lists even if they are absent from the
 * current set, so a user can always see and remove a stale selection.
 */
data class CalendarFacetOptions(
    val scopes: List<CalendarScope>,
    val groups: List<String>,
    val tags: List<String>,
    val importances: List<Importance>,
) {
    val scopeOptions: List<CalendarScope> get() = scopes
    val importanceOptions: List<Importance> get() = importances
}

typealias CalendarFacets = CalendarFacetOptions

/**
 * The deliberately small occurrence vocabulary consumed by projection code.
 * It mirrors authorized Calendar V2 effective occurrences without importing
 * unsupported prototype fields such as owner, color, place, or reminders.
 */
data class CalendarProjectionOccurrence(
    val eventId: String,
    val occurrenceId: String,
    val originalStart: String? = null,
    val recurring: Boolean = false,
    val recurrence: StructuredRecurrence? = null,
    val revision: Int = 0,
    val scope: CalendarScope,
    val title: String,
    val description: String? = null,
    /** Raw RFC3339 value or an all-day yyyy-MM-dd identity. */
    val start: String,
    /** Raw RFC3339 value or an exclusive all-day yyyy-MM-dd boundary. */
    val end: String? = null,
    val visibility: Visibility = Visibility.EVERYONE,
    val importance: Importance,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    /** Preserved only when the source explicitly carried a named event zone. */
    val persistedTimeZoneId: String? = null,
) {
    val actionIdentity: CalendarEventActionIdentity
        get() = CalendarEventActionIdentity(eventId, occurrenceId, originalStart, scope)
}

/** Identity used by event actions and rendering keys; revision is metadata, not identity. */
data class CalendarEventActionIdentity(
    val eventId: String,
    val occurrenceId: String,
    val originalStart: String?,
    val scope: CalendarScope,
) {
    /** Length-prefixing prevents delimiter collisions between user/server IDs. */
    val stableKey: String
        get() = listOf(eventId, occurrenceId, originalStart.orEmpty(), scope.name)
            .joinToString("") { "${it.length}:$it" }
}

/** A half-open local-date interval. [endExclusive] is never included. */
data class CalendarDateInterval(
    val startDate: String,
    val endExclusive: String,
) {
    init {
        require(isCalendarDate(startDate)) { "Invalid calendar interval start: $startDate" }
        require(isCalendarDate(endExclusive)) { "Invalid calendar interval end: $endExclusive" }
        require(compareCalendarDates(startDate, endExclusive) < 0) {
            "Calendar interval must have a positive duration"
        }
    }

    val endDateInclusive: String
        get() = addCalendarDays(endExclusive, -1)

    fun contains(date: String): Boolean =
        compareCalendarDates(startDate, date) <= 0 && compareCalendarDates(date, endExclusive) < 0

    fun intersects(other: CalendarDateInterval): Boolean =
        compareCalendarDates(startDate, other.endExclusive) < 0 &&
            compareCalendarDates(other.startDate, endExclusive) < 0
}

typealias CalendarInterval = CalendarDateInterval

/** All-day values stay date identities; timed values retain their raw wire value. */
sealed interface CalendarProjectedTime {
    val rawValue: String
    val date: String
    val kind: CalendarEventKind

    data class AllDay(
        override val rawValue: String,
        override val date: String = rawValue,
    ) : CalendarProjectedTime {
        override val kind: CalendarEventKind = CalendarEventKind.ALL_DAY
    }

    data class Timed(
        override val rawValue: String,
        /** The unmodified persisted RFC3339 value, retained as the instant identity. */
        val instant: String = rawValue,
        override val date: String,
        /** Local device clock in 24-hour HH:mm form, suitable for deterministic sorting. */
        val localTime: String,
        /** Locale/hour-cycle-aware label for rendering and accessibility. */
        val displayTime: String,
        /** Explicit source zone when one was supplied by the source adapter. */
        val persistedTimeZoneId: String? = null,
    ) : CalendarProjectedTime {
        override val kind: CalendarEventKind = CalendarEventKind.TIMED
    }
}

enum class CalendarEventKind {
    ALL_DAY,
    TIMED,
}

/** One effective occurrence after local temporal projection. */
data class CalendarProjectedEvent(
    val occurrence: CalendarProjectionOccurrence,
    val start: CalendarProjectedTime,
    val end: CalendarProjectedTime?,
    val dateRange: CalendarDateInterval,
    val accessibilityLabel: String,
) {
    val actionIdentity: CalendarEventActionIdentity get() = occurrence.actionIdentity
    val eventId: String get() = occurrence.eventId
    val occurrenceId: String get() = occurrence.occurrenceId
    val originalStart: String? get() = occurrence.originalStart
    val recurring: Boolean get() = occurrence.recurring
    val revision: Int get() = occurrence.revision
    val scope: CalendarScope get() = occurrence.scope
    val title: String get() = occurrence.title
    val visibility: Visibility get() = occurrence.visibility
    val importance: Importance get() = occurrence.importance
    val recurrence: StructuredRecurrence? get() = occurrence.recurrence
    val group: String? get() = occurrence.group
    val tags: List<String> get() = occurrence.tags
    val kind: CalendarEventKind get() = start.kind
    val isAllDay: Boolean get() = kind == CalendarEventKind.ALL_DAY
}

/** Semantic event marker; rendering can turn this into a dot without losing identity. */
data class CalendarEventIndicator(
    val actionIdentity: CalendarEventActionIdentity,
    val kind: CalendarEventKind,
    val title: String,
    val accessibilityLabel: String,
)

data class CalendarOverflow(
    val count: Int,
    val label: String,
    val accessibilityLabel: String = label,
) {
    init {
        require(count > 0) { "Calendar overflow must contain at least one event" }
    }
}

/** A date cell shared by Week, Month, and compact Year summaries. */
data class CalendarDateCell(
    val date: String,
    val dayOfMonth: Int,
    val events: List<CalendarProjectedEvent>,
    val indicators: List<CalendarEventIndicator>,
    val overflow: CalendarOverflow?,
    val isSelected: Boolean,
    val isToday: Boolean,
    val isOutsideMonth: Boolean,
    val accessibilityLabel: String,
) {
    val overflowCount: Int get() = overflow?.count ?: 0
    val hasEvents: Boolean get() = events.isNotEmpty()
}

typealias CalendarMonthCell = CalendarDateCell
typealias CalendarWeekDay = CalendarDateCell
typealias CalendarYearDay = CalendarDateCell

data class CalendarAgendaSection(
    val date: String,
    val events: List<CalendarProjectedEvent>,
    val accessibilityLabel: String,
)

data class CalendarDayProjection(
    val date: String,
    val events: List<CalendarProjectedEvent>,
    val agenda: List<CalendarAgendaSection>,
    val isSelected: Boolean,
    val isToday: Boolean,
    val accessibilityLabel: String,
)

data class CalendarWeekdayLabel(
    val weekday: Weekday,
    val shortLabel: String,
    val accessibilityLabel: String,
)

data class CalendarWeekProjection(
    val startDate: String,
    val endDate: String,
    val days: List<CalendarDateCell>,
    val events: List<CalendarProjectedEvent>,
    val agenda: List<CalendarAgendaSection>,
    val weekdayLabels: List<CalendarWeekdayLabel>,
) {
    init {
        require(days.size == 7) { "A calendar week must contain seven dates" }
        require(weekdayLabels.size == 7) { "A calendar week must contain seven labels" }
    }
}

data class CalendarMonthProjection(
    val year: Int,
    val month: Int,
    val gridStartDate: String,
    val gridEndDate: String,
    val cells: List<CalendarDateCell>,
    val weekdayLabels: List<CalendarWeekdayLabel>,
) {
    init {
        require(cells.size == 42) { "A calendar month must contain 42 cells" }
        require(weekdayLabels.size == 7) { "A calendar month must contain seven labels" }
    }
}

data class CalendarYearMonthSummary(
    val year: Int,
    val month: Int,
    val days: List<CalendarYearDay>,
    val events: List<CalendarProjectedEvent>,
    val eventDates: List<String>,
    val accessibilityLabel: String,
) {
    val eventDayCount: Int get() = eventDates.size
}

data class CalendarYearProjection(
    val year: Int,
    val months: List<CalendarYearMonthSummary>,
) {
    init {
        require(months.size == 12) { "A calendar year must contain twelve months" }
    }
}

/** Complete pure result consumed by a shared coordinator or a native ViewModel. */
data class CalendarExperienceProjection(
    val view: CalendarView,
    val anchorDate: String,
    val selectedDate: String,
    val todayDate: String,
    val locale: CalendarLocale,
    val filters: CalendarFilters,
    val interval: CalendarDateInterval,
    val authorizedOccurrences: List<CalendarProjectionOccurrence>,
    val filteredOccurrences: List<CalendarProjectionOccurrence>,
    val facets: CalendarFacetOptions,
    val day: CalendarDayProjection?,
    val week: CalendarWeekProjection?,
    val month: CalendarMonthProjection?,
    val year: CalendarYearProjection?,
) {
    val activeView: CalendarView get() = view
    val activeFacets: CalendarFilters get() = filters
    val visibleEvents: List<CalendarProjectedEvent>
        get() = listOfNotNull(day?.events, week?.events, month?.cells?.flatMap { it.events }, year?.months?.flatMap { it.events })
            .flatten()
            .distinctBy { it.actionIdentity }
            .sortedWith(calendarEventComparator())
    val events: List<CalendarProjectedEvent> get() = visibleEvents
    val matchingOccurrences: List<CalendarProjectionOccurrence> get() = filteredOccurrences
    val visibleOccurrences: List<CalendarProjectionOccurrence>
        get() = visibleEvents.map { it.occurrence }
}

/** Inputs to the pure projection function. */
data class CalendarProjectionRequest(
    val occurrences: List<CalendarProjectionOccurrence>,
    val anchorDate: String,
    val view: CalendarView = CalendarView.MONTH,
    val selectedDate: String = anchorDate,
    val todayDate: String = anchorDate,
    val locale: CalendarLocale = CalendarLocale(),
    val filters: CalendarFilters = CalendarFilters(),
)

typealias CalendarProjectionInput = CalendarProjectionRequest

/** Persistable presentation state. Today is supplied by the coordinator at projection time. */
data class CalendarPreferences(
    val view: CalendarView = CalendarView.MONTH,
    val anchorDate: String,
    val selectedDate: String = anchorDate,
    val filters: CalendarFilters = CalendarFilters(),
    val locale: CalendarLocale = CalendarLocale(),
) {
    val activeFacets: CalendarFilters get() = filters
}

data class CalendarExperienceState(
    val anchorDate: String,
    val view: CalendarView = CalendarView.MONTH,
    val selectedDate: String = anchorDate,
    val filters: CalendarFilters = CalendarFilters(),
    val locale: CalendarLocale = CalendarLocale(),
    val todayDate: String = anchorDate,
    /** The half-open interval currently requested by the shared coordinator. */
    val visibleInterval: CalendarDateInterval? = null,
    /** The focused day as a half-open interval, when a selected date exists. */
    val selectedInterval: CalendarDateInterval? = null,
    /** Complete, unfiltered authorized data. Never the locally filtered subset. */
    val authorizedOccurrences: List<EffectiveOccurrence> = emptyList(),
    /** The pure local projection over [authorizedOccurrences]. */
    val projection: CalendarExperienceProjection? = null,
    /** Facets are derived from the complete authorized set, not filtered rows. */
    val facets: CalendarFacetOptions = emptyCalendarFacets(),
    val freshness: CalendarFreshness = CalendarFreshness.STALE,
    val loading: CalendarLoadingState = CalendarLoadingState(),
    val offline: CalendarOfflineState = CalendarOfflineState.ONLINE,
    val error: CalendarExperienceError? = null,
    val hasCompleteCache: Boolean = false,
    /** The cache key that supplied [authorizedOccurrences], if any. */
    val cachedWindow: CalendarCacheWindow? = null,
    /** Validated persisted controls as decoded from the shared cache store. */
    val persistedCachePreferences: CalendarCachePreferences? = null,
    val mutationAvailability: CalendarMutationAvailability = CalendarMutationAvailability(),
) {
    val activeFacets: CalendarFilters get() = filters

    /** A platform-neutral validated presentation preference view. */
    val preferences: CalendarPreferences
        get() = CalendarPreferences(view, anchorDate, selectedDate, filters, locale)

    val validatedPreferences: CalendarPreferences get() = preferences
    val persistedPreferences: CalendarCachePreferences? get() = persistedCachePreferences
    val projections: CalendarExperienceProjection? get() = projection
    val calendarProjection: CalendarExperienceProjection? get() = projection
    val occurrences: List<EffectiveOccurrence> get() = authorizedOccurrences
    val authorizedEvents: List<EffectiveOccurrence> get() = authorizedOccurrences
    val visibleWindow: CalendarDateInterval? get() = visibleInterval
    val selectedWindow: CalendarDateInterval? get() = selectedInterval
    val freshnessState: CalendarFreshness get() = freshness
    val loadingState: CalendarLoadingState get() = loading
    val offlineState: CalendarOfflineState get() = offline
    val failure: CalendarExperienceError? get() = error
    val lastError: CalendarExperienceError? get() = error
    val canMutate: Boolean get() = mutationAvailability.isAvailable
    val isLoading: Boolean get() = loading.isLoading
    val isRefreshing: Boolean get() = loading.isRefreshing
    val isOffline: Boolean get() = offline != CalendarOfflineState.ONLINE
    val isUnavailableOffline: Boolean get() = offline == CalendarOfflineState.UNAVAILABLE
    val hasCachedContent: Boolean get() = hasCompleteCache
    val data: CalendarExperienceProjection? get() = projection
    val activeProjection: CalendarExperienceProjection? get() = projection
    val filteredOccurrences: List<CalendarProjectionOccurrence>
        get() = projection?.filteredOccurrences.orEmpty()
    val visibleEvents: List<CalendarProjectedEvent>
        get() = projection?.visibleEvents.orEmpty()

    fun toPreferences(): CalendarPreferences = preferences

    fun toProjectionRequest(occurrences: List<CalendarProjectionOccurrence>): CalendarProjectionRequest =
        CalendarProjectionRequest(
            occurrences = occurrences,
            anchorDate = anchorDate,
            view = view,
            selectedDate = selectedDate,
            todayDate = todayDate,
            locale = locale,
            filters = filters,
        )
}

typealias CalendarProjectionState = CalendarExperienceState

/** Convert the authoritative V2 effective occurrence into the projection vocabulary. */
fun EffectiveOccurrence.toCalendarProjectionOccurrence(): CalendarProjectionOccurrence =
    CalendarProjectionOccurrence(
        eventId = eventId,
        occurrenceId = occurrenceId,
        originalStart = originalStart,
        recurring = recurring,
        recurrence = recurrence,
        revision = revision,
        scope = scope,
        title = title,
        description = description,
        start = start,
        end = end,
        visibility = visibility,
        importance = importance,
        group = group,
        tags = tags,
    )

/** Source-compatible adapter for callers that still hold CalendarEvent values. */
fun CalendarEvent.toCalendarProjectionOccurrence(): CalendarProjectionOccurrence =
    CalendarProjectionOccurrence(
        eventId = eventId,
        occurrenceId = occurrenceId ?: eventId,
        originalStart = originalStart?.toWireValue(),
        recurring = recurrence != null || occurrenceId != null,
        recurrence = recurrence,
        revision = revision,
        scope = scope,
        title = title,
        description = description,
        start = start.toWireValue(),
        end = end?.toWireValue(),
        visibility = visibility,
        importance = importance,
        group = group,
        tags = tags,
        persistedTimeZoneId = (start as? io.sentient.mobilesdk.calendar.CalendarTime.Timed)
            ?.timeZoneId
            ?.takeUnless { it == CALENDAR_WIRE_TIME_ZONE },
    )

/** The common date operations used by projections and navigation. */
object CalendarDates {
    fun isValid(date: String): Boolean = isCalendarDate(date)

    fun addDays(date: String, days: Int): String = addCalendarDays(date, days)

    fun addMonthsClamped(date: String, months: Int): String = addCalendarMonthsClamped(date, months)

    fun addYearsClamped(date: String, years: Int): String = addCalendarYearsClamped(date, years)

    fun daysInMonth(year: Int, month: Int): Int = daysInCalendarMonth(year, month)

    fun dayOfWeek(date: String): Weekday = calendarWeekday(date)
}

internal fun defaultWeekStartForLocale(languageTag: String): Weekday {
    val normalized = languageTag.replace('_', '-')
    val region = normalized.substringAfter('-', "").uppercase().takeIf { it.length == 2 }
    return when (region) {
        "AE", "BH", "DJ", "DZ", "EG", "IQ", "JO", "KW", "OM", "QA", "SA", "SD", "SY", "YE" -> Weekday.SATURDAY
        "AU", "CA", "JP", "KR", "MX", "NZ", "PH", "TH", "TW", "US" -> Weekday.SUNDAY
        else -> Weekday.MONDAY
    }
}
