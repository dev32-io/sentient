package io.sentient.android.settings.calendar

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.calendar.CalendarSessionState
import io.sentient.mobiledata.calendar.CalendarAgendaSection
import io.sentient.mobiledata.calendar.CalendarConflictReviewState
import io.sentient.mobiledata.calendar.CalendarDateInterval
import io.sentient.mobiledata.calendar.CalendarDeleteConfirmationState
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.calendar.CalendarExperienceError
import io.sentient.mobiledata.calendar.CalendarExperienceIntent
import io.sentient.mobiledata.calendar.CalendarExperienceState
import io.sentient.mobiledata.calendar.CalendarFacetOptions
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarFreshness
import io.sentient.mobiledata.calendar.CalendarLoadingPhase
import io.sentient.mobiledata.calendar.CalendarLoadingState
import io.sentient.mobiledata.calendar.CalendarLocale
import io.sentient.mobiledata.calendar.CalendarMonthProjection
import io.sentient.mobiledata.calendar.CalendarMutationAvailability
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobiledata.calendar.CalendarMutationOutcome
import io.sentient.mobiledata.calendar.CalendarMutationPhase
import io.sentient.mobiledata.calendar.CalendarNavigationAction
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobiledata.calendar.CalendarProjectedEvent
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.CalendarWeekProjection
import io.sentient.mobiledata.calendar.CalendarYearProjection
import io.sentient.mobiledata.calendar.CalendarDayProjection
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/** Stable semantic content states. Rendering and geometry remain Compose concerns. */
enum class CalendarContentState {
    LOADING,
    EMPTY,
    CONTENT,
    ERROR,
    UNAVAILABLE_OFFLINE,
}

/**
 * Immutable Android projection of the session-owned shared calendar state.
 *
 * Shared projection and mutation values are deliberately retained rather than
 * reconstructed. This keeps occurrence identity and all calendar policy at the
 * shared boundary while giving Compose one state object to render.
 */
data class CalendarUiState(
    val anchorDate: String,
    val selectedDate: String,
    val todayDate: String,
    val view: CalendarView,
    val locale: CalendarLocale,
    val filters: CalendarFilters,
    val visibleInterval: CalendarDateInterval?,
    val selectedInterval: CalendarDateInterval?,
    val day: CalendarDayProjection?,
    val week: CalendarWeekProjection?,
    val month: CalendarMonthProjection?,
    val year: CalendarYearProjection?,
    val facets: CalendarFacetOptions,
    /** Exact authorized values used by preview/edit callbacks; identities are never rebuilt on Android. */
    val authorizedOccurrences: List<EffectiveOccurrence>,
    val agendaRows: List<CalendarAgendaSection>,
    val visibleEvents: List<CalendarProjectedEvent>,
    val freshness: CalendarFreshness,
    val offline: CalendarOfflineState,
    val loading: CalendarLoadingState,
    val hasCompleteCache: Boolean,
    /** Native intents stay gated until shared persisted presentation has been projected. */
    val presentationReady: Boolean = false,
    val contentState: CalendarContentState,
    val error: CalendarExperienceError?,
    val mutationAvailability: CalendarMutationAvailability,
    val mutationPhase: CalendarMutationPhase,
    val preview: EffectiveOccurrence?,
    val editor: CalendarMutationEditorState?,
    val deleteConfirmation: CalendarDeleteConfirmationState?,
    val conflict: CalendarConflictReviewState?,
    val mutationError: CalendarMutationError?,
    /** Acknowledged shared state: it remains present until [acknowledgeOutcome]. */
    val outcome: CalendarMutationOutcome?,
) {
    val isRefreshing: Boolean get() = loading.isRefreshing || freshness == CalendarFreshness.REFRESHING
    val isOffline: Boolean get() = offline != CalendarOfflineState.ONLINE
    val isEmpty: Boolean get() = contentState == CalendarContentState.EMPTY
    val isSubmitting: Boolean get() = mutationPhase == CalendarMutationPhase.SUBMITTING
    val permissionError: CalendarMutationError? get() = mutationError?.takeIf { it.isPermission }
}

/**
 * Route-scoped collector over a session-scoped [CalendarExperience]. Clearing
 * this ViewModel cancels only collection; ownership and closing stay with the
 * authenticated session.
 */
class CalendarViewModel internal constructor(
    sharedState: StateFlow<CalendarExperienceState>,
    private val forward: (CalendarExperienceIntent) -> Unit,
    startExperience: () -> Unit,
    collectionScope: CoroutineScope? = null,
    private val sessionState: StateFlow<CalendarSessionState>? = null,
) : ViewModel() {
    constructor(experience: CalendarExperience?) : this(
        sharedState = experience?.state ?: MutableStateFlow(CalendarExperienceState(
            anchorDate = "1970-01-01",
            selectedDate = "1970-01-01",
            todayDate = "1970-01-01",
            offline = CalendarOfflineState.UNAVAILABLE,
        )),
        forward = experience?.let { value -> { intent -> value.dispatch(intent) } } ?: {},
        startExperience = experience?.let { value -> { value.start() } } ?: {},
        collectionScope = null,
    )

    /** Production constructor follows the asynchronous protected-store lifecycle. */
    internal constructor(
        sessionState: StateFlow<CalendarSessionState>,
        currentExperience: () -> CalendarExperience?,
    ) : this(
        sharedState = MutableStateFlow(unavailableCalendarExperienceState()),
        forward = { intent -> currentExperience()?.dispatch(intent) },
        startExperience = {},
        sessionState = sessionState,
    )

    private val _ui = MutableStateFlow(sharedState.value.toAndroidUiState())
    val ui: StateFlow<CalendarUiState> = _ui.asStateFlow()

    init {
        val scope = collectionScope ?: viewModelScope
        if (sessionState == null) {
            // start() is shared/idempotent. Route recreation joins the existing
            // observation and never acquires ownership of the experience.
            startExperience()
            scope.launch { sharedState.collect { _ui.value = it.toAndroidUiState() } }
        } else {
            // The route can be created while app-private SQLite is still opening.
            // Join the published session experience instead of permanently binding
            // the ViewModel to a native fallback/default state.
            scope.launch {
                sessionState.collectLatest { session ->
                    when (session) {
                        is CalendarSessionState.Available -> {
                            session.experience.start()
                            session.experience.state.collect { _ui.value = it.toAndroidUiState() }
                        }
                        is CalendarSessionState.Unavailable,
                        CalendarSessionState.Unauthenticated,
                        -> _ui.value = unavailableCalendarExperienceState().toAndroidUiState()
                    }
                }
            }
        }
    }

    fun today() = navigate(CalendarNavigationAction.Today)
    fun previous() = navigate(CalendarNavigationAction.Previous)
    fun next() = navigate(CalendarNavigationAction.Next)
    fun selectDate(date: String) = navigate(CalendarNavigationAction.SelectDate(date))
    fun selectMonth(year: Int, month: Int) = navigate(CalendarNavigationAction.SelectMonth(year, month))
    fun selectView(view: CalendarView) = navigate(CalendarNavigationAction.SelectView(view))
    fun setFilters(filters: CalendarFilters) = navigate(CalendarNavigationAction.SetFilters(filters))
    fun search(text: String) = setFilters(ui.value.filters.copy(text = text))
    fun setLocale(locale: CalendarLocale) = forward(CalendarExperienceIntent.SetLocale(locale))
    fun refresh() = forward(CalendarExperienceIntent.Refresh)

    fun openPreview(occurrence: EffectiveOccurrence) =
        forward(CalendarExperienceIntent.OpenPreview(occurrence))

    fun add(draft: CalendarMutationDraft? = null) =
        forward(CalendarExperienceIntent.CreateDraft(draft))

    fun edit(occurrence: EffectiveOccurrence, inputTimeZoneId: String? = null) =
        forward(CalendarExperienceIntent.EditOccurrence(occurrence, inputTimeZoneId))

    fun openEditor(occurrence: EffectiveOccurrence?, draft: CalendarMutationDraft? = null) =
        forward(CalendarExperienceIntent.OpenEditor(occurrence, draft))

    fun updateDraft(draft: CalendarMutationDraft) =
        forward(CalendarExperienceIntent.UpdateDraft(draft))

    fun chooseRecurrenceScope(scope: CalendarMutationScope) =
        forward(CalendarExperienceIntent.ChooseMutationScope(scope))

    fun save(draft: CalendarMutationDraft? = null) =
        forward(CalendarExperienceIntent.Submit(draft))

    fun requestDelete() = forward(CalendarExperienceIntent.RequestDelete)

    fun confirmDelete(scope: CalendarMutationScope? = null) =
        forward(CalendarExperienceIntent.ConfirmDelete(scope))

    fun rereadConflict() = forward(CalendarExperienceIntent.RereadConflict)

    fun reviewConflict(draft: CalendarMutationDraft) =
        forward(CalendarExperienceIntent.ReviewConflict(draft))

    fun close() = forward(CalendarExperienceIntent.Cancel)
    fun acknowledgeOutcome() = forward(CalendarExperienceIntent.AcknowledgeOutcome)

    private fun navigate(action: CalendarNavigationAction) =
        forward(CalendarExperienceIntent.Navigate(action))
}

private fun unavailableCalendarExperienceState() = CalendarExperienceState(
    anchorDate = "1970-01-01",
    selectedDate = "1970-01-01",
    todayDate = "1970-01-01",
    offline = CalendarOfflineState.UNAVAILABLE,
    loading = CalendarLoadingState(CalendarLoadingPhase.LOADING),
)

internal fun CalendarExperienceState.toAndroidUiState(): CalendarUiState {
    val projection = projection
    val agenda = when (view) {
        CalendarView.DAY -> projection?.day?.agenda
        CalendarView.WEEK -> projection?.week?.agenda
        CalendarView.MONTH -> projection?.month?.agenda
        CalendarView.YEAR -> null
    }.orEmpty()
    val visibleEvents = projection?.visibleEvents.orEmpty()
    val contentState = when {
        isUnavailableOffline -> CalendarContentState.UNAVAILABLE_OFFLINE
        loading.isInitial && projection == null -> CalendarContentState.LOADING
        error != null && projection == null -> CalendarContentState.ERROR
        visibleEvents.isEmpty() -> CalendarContentState.EMPTY
        else -> CalendarContentState.CONTENT
    }
    return CalendarUiState(
        anchorDate = anchorDate,
        selectedDate = selectedDate,
        todayDate = todayDate,
        view = view,
        locale = locale,
        filters = filters,
        visibleInterval = visibleInterval,
        selectedInterval = selectedInterval,
        day = projection?.day,
        week = projection?.week,
        month = projection?.month,
        year = projection?.year,
        facets = facets,
        authorizedOccurrences = authorizedOccurrences,
        agendaRows = agenda,
        visibleEvents = visibleEvents,
        freshness = freshness,
        offline = offline,
        loading = loading,
        hasCompleteCache = hasCompleteCache,
        presentationReady = presentationReady,
        contentState = contentState,
        error = error,
        mutationAvailability = mutationAvailability,
        mutationPhase = mutation.phase,
        preview = mutation.preview,
        editor = mutation.editor,
        deleteConfirmation = mutation.deleteConfirmation,
        conflict = mutation.conflict,
        mutationError = mutation.error,
        outcome = mutation.outcome,
    )
}

/** Android date-picker conversion. All identity and non-temporal draft fields survive unchanged. */
fun CalendarMutationDraft.withAllDayPickerValues(start: LocalDate, end: LocalDate?): CalendarMutationDraft =
    copy(allDay = true, start = start.toString(), end = end?.toString())

/** Android time-picker conversion to wire instants without changing the shared draft identity or zone metadata. */
fun CalendarMutationDraft.withTimedPickerValues(
    start: LocalDateTime,
    end: LocalDateTime?,
    zone: ZoneId,
): CalendarMutationDraft = copy(
    allDay = false,
    start = start.atZone(zone).toOffsetDateTime().toString(),
    end = end?.atZone(zone)?.toOffsetDateTime()?.toString(),
)
