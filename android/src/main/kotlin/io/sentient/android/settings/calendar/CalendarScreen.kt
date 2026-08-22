package io.sentient.android.settings.calendar

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.mobiledata.calendar.CalendarAgendaSection
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarProjectedEvent
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import java.security.MessageDigest
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** Result used by both the system Back handler and the visible top-bar back affordance. */
enum class CalendarBackAction { DISMISS_OVERLAY, NAVIGATE_UP }

fun calendarBackAction(hasVisibleOverlay: Boolean): CalendarBackAction =
    if (hasVisibleOverlay) CalendarBackAction.DISMISS_OVERLAY else CalendarBackAction.NAVIGATE_UP

/**
 * Route assembly only. CalendarExperience owns reads, cache, preferences, filtering,
 * prefetch, and mutation policy; this composable projects device locale and forwards UI intents.
 */
@Composable
fun CalendarScreen(vm: CalendarViewModel, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val configuration = LocalConfiguration.current
    val languageTag = configuration.locales[0]?.toLanguageTag().orEmpty().ifBlank { "en-US" }
    val timeZoneId = ZoneId.systemDefault().id
    LaunchedEffect(languageTag, timeZoneId) {
        if (state.locale.languageTag != languageTag || state.locale.timeZoneId != timeZoneId) {
            vm.setLocale(state.locale.copy(languageTag = languageTag, timeZoneId = timeZoneId))
        }
    }

    val addFocusRequester = remember { FocusRequester() }
    var overlayOrigin by remember { mutableStateOf<CalendarOverlayFocusOrigin?>(null) }
    var overlayOriginRequester by remember { mutableStateOf<FocusRequester?>(null) }

    fun dismissOrNavigate() {
        when (calendarBackAction(state.hasVisibleOverlay)) {
            CalendarBackAction.DISMISS_OVERLAY -> vm.close()
            CalendarBackAction.NAVIGATE_UP -> onBack()
        }
    }
    BackHandler(enabled = state.hasVisibleOverlay, onBack = vm::close)

    CalendarScaffold(
        state = state,
        title = calendarHeadingTitle(state),
        subtitle = calendarHeadingSubtitle(state),
        callbacks = CalendarSurfaceCallbacks(
            onBack = ::dismissOrNavigate,
            onAdd = {
                overlayOrigin = CalendarOverlayFocusOrigin.ADD
                overlayOriginRequester = addFocusRequester
                vm.add()
            },
            onToday = vm::today,
            onPrevious = vm::previous,
            onNext = vm::next,
            onDateSelected = vm::selectDate,
            onMonthSelected = vm::selectMonth,
            onViewSelected = vm::selectView,
            onScopeSelected = { scope -> vm.setFilters(state.filters.copy(scope = scope)) },
            onGroupToggled = { group -> vm.setFilters(state.filters.toggleGroup(group)) },
            onTagToggled = { tag -> vm.setFilters(state.filters.toggleTag(tag)) },
            onImportanceSelected = { importance -> vm.setFilters(state.filters.copy(importance = importance)) },
            onSearchChanged = vm::search,
            onEventSelected = { event, requester ->
                authorizedOccurrenceFor(event, state.authorizedOccurrences)?.let { occurrence ->
                    overlayOrigin = CalendarOverlayFocusOrigin.EVENT
                    overlayOriginRequester = requester
                    vm.openPreview(occurrence)
                }
            },
            onRetry = vm::refresh,
        ),
        modifier = modifier.testTag(CalendarTestTags.SCREEN),
        agendaSections = calendarAgendaSections(state),
        addFocusRequester = addFocusRequester,
    )
    CalendarOverlays(
        state = state,
        actions = CalendarOverlayActions(
            onDismiss = vm::close,
            onEdit = vm::edit,
            onDraftChange = vm::updateDraft,
            onScopeChange = vm::chooseRecurrenceScope,
            onSave = vm::save,
            onRequestDelete = vm::requestDelete,
            onConfirmDelete = vm::confirmDelete,
            onRereadConflict = vm::rereadConflict,
            onReviewConflict = vm::reviewConflict,
            onAcknowledgeOutcome = vm::acknowledgeOutcome,
        ),
        origin = overlayOrigin,
        originFocusRequester = overlayOriginRequester,
        fallbackFocusRequester = addFocusRequester,
    )
}

object CalendarTestTags {
    const val SCREEN = "calendar-screen"
    const val TOP_BAR = "calendar-topbar"
    const val BACK = "calendar-back"
    const val ADD = "calendar-add"
    const val HEADING = "calendar-heading"
    const val TODAY = "calendar-today"
    const val PREVIOUS = "calendar-previous"
    const val NEXT = "calendar-next"
    const val FILTERS = "calendar-filters"
    const val SEARCH = "calendar-filter-search"
    const val CANVAS = "calendar-canvas"
    const val AGENDA = "calendar-agenda"
    const val FRESHNESS = "calendar-freshness"
    const val STATUS = "calendar-status"
    const val RETRY = "calendar-retry"
    const val OFFLINE = "calendar-offline"
    const val UNAVAILABLE_OFFLINE = "calendar-unavailable-offline"
    const val VIEW_BAR = "calendar-view-bar"
}

fun calendarViewTag(view: CalendarView) = "calendar-view-${view.name.lowercase()}"
fun calendarDateTag(date: String) = "calendar-date-$date"
fun calendarFilterTag(kind: String, value: String) = "calendar-filter-$kind-${calendarTagToken(value)}"
fun calendarEventTag(event: CalendarProjectedEvent) = "calendar-event-${calendarTagToken(event.actionIdentity.stableKey)}"

/** One-way digest keeps dynamic IDs content-free and valid for resource-id based drivers. */
internal fun calendarTagToken(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.encodeToByteArray())
    .take(12)
    .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }

internal fun CalendarFilters.toggleGroup(group: String): CalendarFilters =
    copy(groups = groups.toggle(group))

internal fun CalendarFilters.toggleTag(tag: String): CalendarFilters =
    copy(tags = tags.toggle(tag))

private fun Set<String>.toggle(value: String): Set<String> =
    if (value in this) this - value else this + value

/** Exact authorized values are selected; Android never reconstructs occurrence identity. */
fun authorizedOccurrenceFor(
    event: CalendarProjectedEvent,
    occurrences: List<EffectiveOccurrence>,
): EffectiveOccurrence? = occurrences.firstOrNull { occurrence ->
    occurrence.eventId == event.eventId &&
        occurrence.occurrenceId == event.occurrenceId &&
        occurrence.scope == event.scope &&
        occurrence.revision == event.revision &&
        (event.originalStart == null || occurrence.originalStart == event.originalStart)
}

fun calendarHeadingTitle(state: CalendarUiState): String {
    val locale = Locale.forLanguageTag(state.locale.languageTag)
    val anchor = LocalDate.parse(state.anchorDate)
    return when (state.view) {
        CalendarView.DAY -> anchor.format(DateTimeFormatter.ofPattern("MMMM d", locale))
        CalendarView.WEEK -> {
            val start = state.week?.startDate?.let(LocalDate::parse) ?: anchor
            val end = state.week?.endDate?.let(LocalDate::parse) ?: start.plusDays(6)
            if (start.month == end.month) {
                "${start.format(DateTimeFormatter.ofPattern("MMM d", locale))}–${end.dayOfMonth}"
            } else {
                "${start.format(DateTimeFormatter.ofPattern("MMM d", locale))}–${end.format(DateTimeFormatter.ofPattern("MMM d", locale))}"
            }
        }
        CalendarView.MONTH -> calendarMonthTitle(anchor.year, anchor.monthValue, state.locale.languageTag)
        CalendarView.YEAR -> anchor.year.toString()
    }
}

fun calendarHeadingSubtitle(state: CalendarUiState): String {
    if (state.view == CalendarView.YEAR) return "Year at a glance"
    val selected = LocalDate.parse(state.selectedDate)
    val locale = Locale.forLanguageTag(state.locale.languageTag)
    return "${selected.dayOfWeek.getDisplayName(TextStyle.FULL, locale)} · ${selected.dayOfMonth}"
}

/** Uses only the agenda window supplied by the shared projection. */
fun calendarAgendaSections(state: CalendarUiState): List<CalendarAgendaSection> = when (state.view) {
    CalendarView.DAY, CalendarView.WEEK, CalendarView.MONTH -> state.agendaRows
    CalendarView.YEAR -> emptyList()
}
