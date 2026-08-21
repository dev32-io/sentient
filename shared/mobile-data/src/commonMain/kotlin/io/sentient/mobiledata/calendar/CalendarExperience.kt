package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CalendarCacheFailureReason
import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheSnapshot
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.coroutines.cancellation.CancellationException as KotlinCancellationException
import kotlin.time.Clock as KtClock

/** Intents accepted by the shared, session-scoped calendar experience. */
sealed interface CalendarExperienceIntent {
    data class Observe(val window: CalendarCacheWindow) : CalendarExperienceIntent
    data class Navigate(val action: CalendarNavigationAction) : CalendarExperienceIntent
    data class SetLocale(val locale: CalendarLocale) : CalendarExperienceIntent
    data object Refresh : CalendarExperienceIntent

    /** Open the effective occurrence preview sheet. */
    data class OpenPreview(val occurrence: EffectiveOccurrence) : CalendarExperienceIntent

    /** Open an editor for an occurrence, or a create editor when it is null. */
    data class OpenEditor(
        val occurrence: EffectiveOccurrence? = null,
        val draft: CalendarMutationDraft? = null,
    ) : CalendarExperienceIntent

    /** Start a new in-memory editor lifecycle. */
    data class CreateDraft(val draft: CalendarMutationDraft? = null) : CalendarExperienceIntent

    /** Edit one effective occurrence without losing its V2 identity. */
    data class EditOccurrence(
        val occurrence: EffectiveOccurrence,
        val inputTimeZoneId: String? = null,
    ) : CalendarExperienceIntent

    /** Replace editable fields while retaining the immutable target identity. */
    data class UpdateDraft(val draft: CalendarMutationDraft) : CalendarExperienceIntent

    data class ChooseMutationScope(val scope: CalendarMutationScope) : CalendarExperienceIntent

    /** Open the explicit delete confirmation sheet; it never writes by itself. */
    data object RequestDelete : CalendarExperienceIntent
    data class ConfirmDelete(val scope: CalendarMutationScope? = null) : CalendarExperienceIntent

    /** Submit the current editor draft, or an explicit replacement draft. */
    data class Submit(val draft: CalendarMutationDraft? = null) : CalendarExperienceIntent

    data object Cancel : CalendarExperienceIntent
    data object RereadConflict : CalendarExperienceIntent
    /** Explicitly review a local draft rebased onto an authoritative reread. */
    data class ReviewConflict(val draft: CalendarMutationDraft) : CalendarExperienceIntent
    data object AcknowledgeOutcome : CalendarExperienceIntent
}

/** Mutation-only naming retained as an ergonomic alias for native adapters. */
typealias CalendarMutationIntent = CalendarExperienceIntent
typealias CalendarReadIntent = CalendarExperienceIntent

typealias OpenCalendarPreviewIntent = CalendarExperienceIntent.OpenPreview
typealias OpenCalendarEditorIntent = CalendarExperienceIntent.OpenEditor
typealias CreateCalendarDraftIntent = CalendarExperienceIntent.CreateDraft
typealias EditCalendarOccurrenceIntent = CalendarExperienceIntent.EditOccurrence
typealias UpdateCalendarDraftIntent = CalendarExperienceIntent.UpdateDraft
typealias ChooseCalendarMutationScopeIntent = CalendarExperienceIntent.ChooseMutationScope
typealias RequestCalendarDeleteIntent = CalendarExperienceIntent.RequestDelete
typealias ConfirmCalendarDeleteIntent = CalendarExperienceIntent.ConfirmDelete
typealias SubmitCalendarMutationIntent = CalendarExperienceIntent.Submit
typealias CancelCalendarMutationIntent = CalendarExperienceIntent.Cancel
typealias RereadCalendarConflictIntent = CalendarExperienceIntent.RereadConflict
typealias ReviewCalendarConflictIntent = CalendarExperienceIntent.ReviewConflict
typealias AcknowledgeCalendarOutcomeIntent = CalendarExperienceIntent.AcknowledgeOutcome

/** A page after the compatibility repository page has been converted losslessly. */
private data class EffectiveOccurrencePage(
    val occurrences: List<EffectiveOccurrence>,
    val nextCursor: String?,
)

private sealed interface AggregationResult {
    data class Complete(val occurrences: List<EffectiveOccurrence>) : AggregationResult
    data class Failed(val error: CalendarExperienceError) : AggregationResult
    data object Cancelled : AggregationResult
}

private data class CacheInputs(
    val snapshot: CalendarCacheResult<CalendarCacheSnapshot?>,
    val preferences: CalendarCacheResult<CalendarCachePreferences?>,
)

private data class CalendarWindowRequestKey(
    val namespace: CalendarCacheNamespace,
    val window: CalendarCacheWindow,
)

/** Captured session identity for mutation/reread continuations. */
private data class MutationContinuationFence(
    val namespace: CalendarCacheNamespace,
    val namespaceGeneration: Long,
    val mutationGeneration: Long,
)

private data class InFlightRequestRegistration(
    val bookkeepingGeneration: Long,
    val deferred: Deferred<WindowLoadResult>,
)

/**
 * The request registry has its own atomic linearization point because request
 * cancellation is also initiated by non-suspending public intents such as
 * [CalendarExperience.observe]. A coroutine Mutex cannot make removal atomic
 * there: falling back to an asynchronous cleanup leaves a stale Deferred
 * visible to the next lookup.
 */
private data class InFlightRequestRegistry(
    val generation: Long,
    val entries: Map<CalendarWindowRequestKey, InFlightRequestRegistration>,
)

private data class BookkeepingJobRegistration(
    val bookkeepingGeneration: Long,
    val job: Job,
)

private sealed interface WindowLoadResult {
    data class Complete(
        val occurrences: List<EffectiveOccurrence>,
        val fetchedAt: Long,
    ) : WindowLoadResult

    data class Failed(val error: CalendarExperienceError) : WindowLoadResult
    data object Cancelled : WindowLoadResult
}

/** Only structural, non-content information is retained for failed prefetches. */
enum class CalendarPrefetchFailureKind {
    CONNECTION,
    AUTHORIZATION,
    FORBIDDEN,
    MALFORMED,
    DECODE,
    CONTRACT,
    DATABASE,
    UNKNOWN,
}

data class CalendarPrefetchDiagnostic(
    val window: CalendarCacheWindow,
    val kind: CalendarPrefetchFailureKind,
    val recordedAt: Long,
)

/**
 * One authenticated-session calendar read experience.
 *
 * The cache flows are started before remote work.  A remote response is folded
 * completely, with an explicit `all` scope, before one cache replacement.  No
 * repository state is retained: the repository remains a stateless transport
 * boundary and this class owns only observation/revalidation coordination.
 */
@OptIn(ExperimentalAtomicApi::class)
class CalendarExperience(
    private val repository: CalendarRepository,
    private val cacheStore: CalendarCacheStore,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    initialWindow: CalendarCacheWindow? = null,
    initialAnchorDate: String? = null,
    initialLocale: CalendarLocale = CalendarLocale(),
    private val nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
    private val todayDate: () -> String = ::defaultCalendarToday,
) {
    private val initialToday = validOrFallbackDate(todayDate(), initialAnchorDate ?: initialWindow?.windowStart)
    private val initialAnchor = validOrFallbackDate(initialAnchorDate, initialWindow?.windowStart ?: initialToday)
    private val initialState = CalendarExperienceState(
        anchorDate = initialAnchor,
        view = CalendarView.MONTH,
        selectedDate = initialAnchor,
        locale = initialLocale,
        todayDate = initialToday,
        visibleInterval = initialWindow?.toDateInterval() ?: calendarVisibleInterval(
            CalendarView.MONTH,
            initialAnchor,
            initialLocale,
        ),
        selectedInterval = selectedDateInterval(initialAnchor),
        mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.UNAVAILABLE),
    )

    private val _state = MutableStateFlow(initialState)
    val state: StateFlow<CalendarExperienceState> = _state.asStateFlow()
    val calendarState: StateFlow<CalendarExperienceState> get() = state
    val states: StateFlow<CalendarExperienceState> get() = state

    private var requestedWindow: CalendarCacheWindow = initialWindow ?: windowFor(
        presentation = initialState,
        timezoneInput = initialWindow?.timezoneInput ?: initialLocale.timeZoneId,
    )
    private var activeWindow: CalendarCacheWindow = requestedWindow
    private var observationJob: Job? = null
    private var refreshJob: Job? = null
    private var mutationJob: Job? = null
    private var mutationRefreshJob: Job? = null
    private var revalidationGeneration: Long? = null
    private var requestGeneration: Long = 0L
    private var preferenceWriteGeneration: Long = 0L
    private var preferenceWriteJob: Job? = null
    private var namespaceGeneration: Long = 0L
    private var mutationGeneration: Long = 0L
    private var observedNamespace: CalendarCacheNamespace = cacheStore.currentNamespace.value
    private var accessDisabled: Boolean = false
    private var bookkeepingGeneration: Long = 0L
    /** Protects prefetch/access bookkeeping and registration. */
    private val bookkeepingMutex = Mutex()
    private val inFlightRequests = AtomicReference(
        InFlightRequestRegistry(generation = 0L, entries = emptyMap()),
    )
    private val prefetchJobs = mutableMapOf<CalendarWindowRequestKey, BookkeepingJobRegistration>()
    private val scheduledPrefetchKeys = mutableMapOf<CalendarWindowRequestKey, Long>()
    private val _prefetchDiagnostics = MutableStateFlow<List<CalendarPrefetchDiagnostic>>(emptyList())
    /** Sanitized failures from adjacent work; visible-window failures use [state]. */
    val prefetchDiagnostics: StateFlow<List<CalendarPrefetchDiagnostic>> = _prefetchDiagnostics.asStateFlow()
    val prefetchFailures: StateFlow<List<CalendarPrefetchDiagnostic>> get() = prefetchDiagnostics
    private val accessWriteJobs = mutableMapOf<CalendarWindowRequestKey, BookkeepingJobRegistration>()
    private var authExpiryJob: Job? = null
    private var namespaceJob: Job? = null
    private var unregisterNamespaceListener: (() -> Unit)? = null
    private var closed: Boolean = false

    init {
        // The SQLDelight store invokes this hook before changing its selected
        // namespace. Keeping the StateFlow collector as a fallback also makes
        // custom/test stores safe when they only expose currentNamespace.
        unregisterNamespaceListener = cacheStore.registerNamespaceChangeListener { namespace ->
            if (!closed && namespace != observedNamespace) {
                invalidateForNamespace(namespace, updateObservedNamespace = false)
            }
        }
        namespaceJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            // Namespace changes are session boundaries, not ordinary cache
            // updates. The collector is started undispatched so custom stores
            // invalidate before a successor cache emission can be applied.
            // The explicit switchNamespace() seam below is synchronous too.
            cacheStore.currentNamespace.collect { namespace ->
                if (namespace == observedNamespace) return@collect
                handleNamespaceChange(namespace)
            }
        }
    }

    /** Compatibility constructor for callers that place the initial window before the coroutine scope. */
    constructor(
        repository: CalendarRepository,
        cacheStore: CalendarCacheStore,
        initialWindow: CalendarCacheWindow,
        scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        initialAnchorDate: String? = null,
        initialLocale: CalendarLocale = CalendarLocale(),
        nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
        todayDate: () -> String = ::defaultCalendarToday,
    ) : this(
        repository,
        cacheStore,
        scope,
        initialWindow,
        initialAnchorDate,
        initialLocale,
        nowMillis,
        todayDate,
    )

    /** The cache key currently used by the foreground observation. */
    val visibleWindow: CalendarCacheWindow get() = activeWindow
    val window: CalendarCacheWindow get() = activeWindow
    val isClosed: Boolean get() = closed

    /**
     * Begin or join observation of [window]. Equivalent active requests share
     * the same cache collectors and remote job; a different window cancels the
     * obsolete foreground aggregation before starting its replacement.
     */
    fun observe(window: CalendarCacheWindow = requestedWindow): StateFlow<CalendarExperienceState> {
        if (closed || accessDisabled) return state
        if (requestedWindow == window && observationJob?.isActive == true) return state

        val changingWindow = requestedWindow != window
        if (changingWindow) {
            cancelPrefetchWork()
            cancelSharedRequests()
        }
        requestedWindow = window
        activeWindow = window
        requestGeneration += 1L
        observationJob?.cancel()
        refreshJob?.cancel()
        refreshJob = null
        revalidationGeneration = null
        markObservationStarted(window)

        val generation = requestGeneration
        val namespace = cacheStore.currentNamespace.value
        val namespaceEpoch = namespaceGeneration
        observedNamespace = namespace
        observationJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            runObservation(window, generation, namespace, namespaceEpoch)
        }
        return state
    }

    /** Source-compatible name for platform session/ViewModel callers. */
    fun start(window: CalendarCacheWindow = requestedWindow): StateFlow<CalendarExperienceState> = observe(window)

    /** Source-compatible request name used by thin native adapters. */
    fun requestWindow(window: CalendarCacheWindow): StateFlow<CalendarExperienceState> = observe(window)

    fun observe(interval: CalendarDateInterval, timezoneInput: String = activeWindow.timezoneInput): StateFlow<CalendarExperienceState> =
        observe(CalendarCacheWindow(interval.startDate, interval.endExclusive, timezoneInput))

    fun observe(windowStart: String, windowEnd: String, timezoneInput: String = activeWindow.timezoneInput): StateFlow<CalendarExperienceState> =
        observe(CalendarCacheWindow(windowStart, windowEnd, timezoneInput))

    fun dispatch(intent: CalendarExperienceIntent) {
        when (intent) {
            is CalendarExperienceIntent.Observe -> observe(intent.window)
            is CalendarExperienceIntent.Navigate -> dispatch(intent.action)
            is CalendarExperienceIntent.SetLocale -> dispatch(CalendarNavigationAction.SetLocale(intent.locale))
            CalendarExperienceIntent.Refresh -> refresh()
            is CalendarExperienceIntent.OpenPreview -> openPreview(intent.occurrence)
            is CalendarExperienceIntent.OpenEditor -> openEditor(intent.occurrence, intent.draft)
            is CalendarExperienceIntent.CreateDraft -> createDraft(intent.draft)
            is CalendarExperienceIntent.EditOccurrence -> editOccurrence(intent.occurrence, intent.inputTimeZoneId)
            is CalendarExperienceIntent.UpdateDraft -> updateDraft(intent.draft)
            is CalendarExperienceIntent.ChooseMutationScope -> chooseMutationScope(intent.scope)
            CalendarExperienceIntent.RequestDelete -> requestDelete()
            is CalendarExperienceIntent.ConfirmDelete -> confirmDelete(intent.scope)
            is CalendarExperienceIntent.Submit -> submitMutation(intent.draft)
            CalendarExperienceIntent.Cancel -> cancelMutation()
            CalendarExperienceIntent.RereadConflict -> rereadConflict()
            is CalendarExperienceIntent.ReviewConflict -> reviewConflict(intent.draft)
            CalendarExperienceIntent.AcknowledgeOutcome -> acknowledgeOutcome()
        }
    }

    /** Source-compatible imperative seams for thin Android/iOS adapters. */
    fun openPreview(occurrence: EffectiveOccurrence) {
        if (closed) return
        mutationGeneration += 1L
        mutationJob?.cancel()
        _state.value = _state.value.copy(
            mutation = _state.value.mutation.copy(
                phase = CalendarMutationPhase.PREVIEWING,
                preview = occurrence,
                editor = null,
                deleteConfirmation = null,
                pendingRequest = null,
                error = null,
                conflict = null,
                outcome = null,
                successorEventId = null,
                affectedWindows = emptyList(),
            ),
        )
    }

    fun closePreview() {
        if (closed) return
        val mutation = _state.value.mutation
        if (mutation.editor != null || mutation.isSubmitting) return
        _state.value = _state.value.copy(mutation = mutation.copy(phase = CalendarMutationPhase.IDLE, preview = null))
    }

    fun openEditor(
        occurrence: EffectiveOccurrence? = null,
        draft: CalendarMutationDraft? = null,
    ) {
        if (occurrence == null) {
            createDraft(draft)
        } else {
            editOccurrence(occurrence, draft?.inputTimeZoneId)
            if (draft != null && _state.value.mutation.editor != null) updateDraft(draft)
        }
    }

    fun createDraft(draft: CalendarMutationDraft? = null) {
        if (closed || accessDisabled) return
        val base = draft ?: CalendarMutationDraft.create(
            start = _state.value.selectedDate,
            end = null,
            allDay = true,
            scope = CalendarScope.PRIVATE,
        )
        val editor = CalendarMutationEditorState(
            mode = CalendarMutationEditorMode.CREATE,
            draft = base.copy(eventId = null, occurrenceId = null, originalStart = null, expectedRevision = null),
            target = null,
            applicableScopes = listOf(CalendarMutationScope.ENTIRE_SERIES),
            selectedScope = CalendarMutationScope.ENTIRE_SERIES,
        )
        setEditorState(editor)
    }

    fun editOccurrence(occurrence: EffectiveOccurrence, inputTimeZoneId: String? = null) {
        if (closed || accessDisabled) return
        if (_state.value.mutation.conflict != null) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict_review_required",
                    userMessage = "Review the latest event before opening it again.",
                ),
            )
            return
        }
        val target = CalendarMutationTarget.fromOccurrence(occurrence)
        if (target == null) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.NOT_FOUND,
                    code = "not_found",
                    userMessage = "This calendar event is no longer available.",
                ),
            )
            return
        }
        val scopes = applicableCalendarMutationScopes(occurrence)
        val editor = CalendarMutationEditorState(
            mode = CalendarMutationEditorMode.EDIT,
            draft = CalendarMutationDraft.fromOccurrence(occurrence, inputTimeZoneId),
            target = target,
            applicableScopes = scopes,
            // A recurring row must make the user choose. A non-recurring row
            // has one applicable scope and is safe to address as a whole.
            selectedScope = scopes.singleOrNull(),
        )
        setEditorState(editor)
    }

    fun updateDraft(draft: CalendarMutationDraft) {
        if (closed || accessDisabled) return
        val editor = _state.value.mutation.editor ?: return
        val retained = if (editor.target == null) {
            draft.copy(eventId = null, occurrenceId = null, originalStart = null, expectedRevision = null)
        } else {
            draft.copy(
                eventId = editor.target.eventId,
                occurrenceId = editor.target.occurrenceId,
                originalStart = editor.target.originalStart,
                expectedRevision = editor.target.expectedRevision,
                scope = editor.target.scope,
                recurring = editor.target.recurring,
            )
        }
        val mutation = _state.value.mutation
        val conflict = mutation.conflict?.copy(
            // Editing a stale draft is not an explicit review of a rebased
            // draft, even when an authoritative event is already available.
            draft = retained,
            reviewed = false,
        )
        val inConflict = conflict != null
        val nextEditor = editor.copy(draft = retained)
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = if (inConflict) CalendarMutationPhase.CONFLICT else CalendarMutationPhase.EDITING,
                editor = nextEditor,
                deleteConfirmation = null,
                error = if (inConflict) mutation.error else null,
                conflict = conflict,
                outcome = if (inConflict) mutation.outcome else null,
            ),
        )
    }

    fun setDraft(draft: CalendarMutationDraft) = updateDraft(draft)

    fun chooseMutationScope(scope: CalendarMutationScope) {
        if (closed) return
        val mutation = _state.value.mutation
        val editor = mutation.editor
        if (editor == null || scope !in editor.applicableScopes) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.VALIDATION,
                    code = "invalid_mutation_scope",
                    userMessage = "Choose an applicable recurrence scope.",
                ),
            )
            return
        }
        val conflict = mutation.conflict
        val blockedByConflict = conflict != null && !conflict.canSubmit
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = when {
                    blockedByConflict -> CalendarMutationPhase.CONFLICT
                    mutation.deleteConfirmation != null -> CalendarMutationPhase.DELETE_CONFIRMATION
                    else -> CalendarMutationPhase.EDITING
                },
                editor = editor.copy(selectedScope = scope),
                deleteConfirmation = mutation.deleteConfirmation?.copy(selectedScope = scope),
                error = if (blockedByConflict) mutation.error else null,
                conflict = conflict,
            ),
        )
    }

    fun selectMutationScope(scope: CalendarMutationScope) = chooseMutationScope(scope)

    fun requestDelete() {
        if (closed) return
        val mutation = _state.value.mutation
        val editor = mutation.editor
        val target = editor?.target
        if (editor == null || target == null || editor.mode != CalendarMutationEditorMode.EDIT) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.NOT_FOUND,
                    code = "not_found",
                    userMessage = "This calendar event is no longer available.",
                ),
            )
            return
        }
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = CalendarMutationPhase.DELETE_CONFIRMATION,
                deleteConfirmation = CalendarDeleteConfirmationState(
                    target = target,
                    applicableScopes = editor.applicableScopes,
                    selectedScope = editor.selectedScope,
                ),
                error = null,
            ),
        )
    }

    fun openDeleteConfirmation() = requestDelete()

    fun confirmDelete(scope: CalendarMutationScope? = null): Job? {
        if (closed) return null
        val mutation = _state.value.mutation
        val confirmation = mutation.deleteConfirmation
        val selected = scope ?: confirmation?.selectedScope
        if (confirmation == null || selected == null || selected !in confirmation.applicableScopes) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.VALIDATION,
                    code = "invalid_mutation_scope",
                    userMessage = "Choose an applicable recurrence scope before deleting.",
                ),
            )
            return null
        }
        val editor = mutation.editor ?: return null
        if (mutation.conflict != null && !mutation.conflict.canSubmit) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict_review_required",
                    userMessage = "Review the latest event before deleting again.",
                ),
            )
            return null
        }
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                editor = editor.copy(selectedScope = selected),
                deleteConfirmation = confirmation.copy(selectedScope = selected),
            ),
        )
        return submitDelete(editor.draft, selected)
    }

    fun submitMutation(draft: CalendarMutationDraft? = null): Job? {
        if (closed) return null
        val editor = _state.value.mutation.editor
        if (editor == null || editor.mode != CalendarMutationEditorMode.CREATE && editor.mode != CalendarMutationEditorMode.EDIT) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONTRACT,
                    code = "no_editor",
                    userMessage = "Open the calendar editor before saving.",
                ),
            )
            return null
        }
        if (draft != null) updateDraft(draft)
        val currentMutation = _state.value.mutation
        val currentEditor = currentMutation.editor ?: return null
        val conflict = currentMutation.conflict
        if (conflict != null && !conflict.canSubmit) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict_review_required",
                    userMessage = "Review the latest event before saving again.",
                ),
            )
            return null
        }
        val scope = currentEditor.selectedScope
        if (currentEditor.isEdit && scope == null) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.VALIDATION,
                    code = "invalid_mutation_scope",
                    userMessage = "Choose an applicable recurrence scope before saving.",
                ),
            )
            return null
        }
        mutationOfflineGate()?.let {
            setMutationError(it)
            return null
        }
        val request = when (currentEditor.mode) {
            CalendarMutationEditorMode.CREATE -> when (val built = buildCalendarCreateInput(currentEditor.draft)) {
                is CalendarCommandBuildResult.Success -> CalendarMutationRequest.Create(built.value)
                is CalendarCommandBuildResult.Failure -> {
                    setMutationError(built.error)
                    return null
                }
            }
            CalendarMutationEditorMode.EDIT -> when (val built = buildCalendarUpdateRequest(currentEditor.draft, scope!!)) {
                is CalendarCommandBuildResult.Success -> built.value
                is CalendarCommandBuildResult.Failure -> {
                    setMutationError(built.error)
                    return null
                }
            }
        }
        return submitRequest(request, currentEditor.draft)
    }

    fun submit() = submitMutation()

    fun cancelMutation() {
        if (closed || _state.value.mutation.isSubmitting) return
        mutationGeneration += 1L
        mutationJob?.cancel()
        mutationJob = null
        _state.value = _state.value.copy(mutation = CalendarMutationState())
    }

    fun cancel() = cancelMutation()

    fun rereadConflict(): Job? {
        if (closed) return null
        val mutation = _state.value.mutation
        val conflict = mutation.conflict
        if (conflict == null || conflict.rereadInFlight) return null
        val target = conflict.target
        val fence = captureMutationFence()
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = CalendarMutationPhase.CONFLICT,
                conflict = conflict.copy(rereadInFlight = true, reviewed = false),
            ),
        )
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val result = try {
                repository.get(
                    id = target.eventId,
                    originalStart = target.originalStart,
                    scope = target.scope,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                SentientResult.Failure(SentientError.Connection("connection required"))
            }
            if (!isMutationFenceCurrent(fence)) return@launch
            when (result) {
                is SentientResult.Success -> {
                    val latest = result.data
                    val current = _state.value.mutation
                    val active = current.conflict ?: return@launch
                    if (active.target != target || !active.rereadInFlight) return@launch
                    // A reread only supplies authoritative material. The user
                    // must explicitly review a draft rebased to this revision
                    // before a write becomes submittable.
                    _state.value = _state.value.copy(
                        mutation = current.copy(
                            phase = CalendarMutationPhase.CONFLICT,
                            conflict = active.copy(
                                rereadInFlight = false,
                                authoritativeEvent = latest,
                                reviewed = false,
                            ),
                        ),
                    )
                }
                is SentientResult.Failure -> {
                    if (result.error is SentientError.Auth) {
                        scheduleAuthenticationExpiry(fence)
                        return@launch
                    }
                    val mapped = mutationError(result.error)
                    if (mapped.kind == CalendarMutationErrorKind.FORBIDDEN) {
                        scheduleForbiddenPurge(fence.namespace, forbiddenMutationReadError())
                        return@launch
                    }
                    val current = _state.value.mutation
                    val active = current.conflict ?: return@launch
                    if (active.target != target || !active.rereadInFlight) return@launch
                    _state.value = _state.value.copy(
                        mutation = current.copy(
                            phase = CalendarMutationPhase.CONFLICT,
                            conflict = active.copy(rereadInFlight = false),
                            error = mapped,
                        ),
                    )
                }
                is SentientResult.Loading -> Unit
            }
        }
        mutationJob = job
        job.invokeOnCompletion { if (mutationJob === job) mutationJob = null }
        return job
    }

    /**
     * Explicitly rebase and review a draft against the authoritative reread.
     * Identity and revision always come from the reread; editable values come
     * from the draft supplied by the user surface.
     */
    fun reviewConflict(draft: CalendarMutationDraft): Boolean {
        if (closed) return false
        val mutation = _state.value.mutation
        val conflict = mutation.conflict
        val authoritative = conflict?.authoritativeEvent
        val editor = mutation.editor
        val latestTarget = authoritative?.let(CalendarMutationTarget::fromEvent)
        if (conflict == null || authoritative == null || conflict.rereadInFlight || editor == null || latestTarget == null) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict_review_required",
                    userMessage = "Read the latest event before reviewing this draft.",
                ),
            )
            return false
        }
        val rebased = draft.copy(
            eventId = latestTarget.eventId,
            occurrenceId = latestTarget.occurrenceId,
            originalStart = latestTarget.originalStart,
            expectedRevision = latestTarget.expectedRevision,
            scope = latestTarget.scope,
            recurring = latestTarget.recurring,
        )
        val selectedScope = editor.selectedScope?.takeIf { it in applicableCalendarMutationScopes(authoritative) }
            ?: applicableCalendarMutationScopes(authoritative).singleOrNull()
        val nextEditor = editor.copy(
            draft = rebased,
            target = latestTarget,
            applicableScopes = applicableCalendarMutationScopes(authoritative),
            selectedScope = selectedScope,
        )
        mutationGeneration += 1L
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = CalendarMutationPhase.EDITING,
                editor = nextEditor,
                deleteConfirmation = null,
                pendingRequest = null,
                error = null,
                conflict = conflict.copy(
                    target = latestTarget,
                    draft = rebased,
                    authoritativeEvent = authoritative,
                    reviewed = true,
                    rereadInFlight = false,
                ),
            ),
        )
        return true
    }

    /** Rebase the current local draft as an explicit review action. */
    fun rebaseConflict(): Boolean {
        val draft = _state.value.mutation.conflict?.draft ?: return false
        return reviewConflict(draft)
    }

    /**
     * Compatibility review action: first invocation rereads, while a later
     * invocation with authoritative material performs the explicit rebase.
     */
    fun reviewConflict(): Job? {
        val conflict = _state.value.mutation.conflict
        return if (conflict?.authoritativeEvent != null && !conflict.rereadInFlight) {
            rebaseConflict()
            null
        } else {
            rereadConflict()
        }
    }

    fun acknowledgeOutcome() {
        if (closed) return
        val mutation = _state.value.mutation
        _state.value = _state.value.copy(
            mutation = mutation.copy(
                phase = if (mutation.editor == null) CalendarMutationPhase.IDLE else mutation.phase,
                outcome = null,
                successorEventId = null,
                affectedWindows = emptyList(),
            ),
        )
    }

    fun acknowledge() = acknowledgeOutcome()

    fun send(intent: CalendarExperienceIntent) = dispatch(intent)
    fun onIntent(intent: CalendarExperienceIntent) = dispatch(intent)

    private fun setEditorState(editor: CalendarMutationEditorState) {
        mutationGeneration += 1L
        mutationJob?.cancel()
        val current = _state.value.mutation
        _state.value = _state.value.copy(
            mutation = current.copy(
                phase = CalendarMutationPhase.EDITING,
                preview = null,
                editor = editor,
                deleteConfirmation = null,
                pendingRequest = null,
                error = null,
                conflict = null,
                outcome = null,
                successorEventId = null,
                affectedWindows = emptyList(),
            ),
        )
    }

    private fun setMutationError(error: CalendarMutationError) {
        if (closed) return
        val current = _state.value.mutation
        val conflict = if (error.isConflict) {
            if (error.code == "conflict_review_required" && current.conflict != null) {
                current.conflict.copy(reviewed = false)
            } else {
                val target = current.target
                val draft = current.draft
                if (target != null && draft != null) {
                    CalendarConflictReviewState(
                        operation = current.pendingRequest?.operation
                            ?: if (current.deleteConfirmation != null) CalendarMutationOperation.DELETE
                            else if (current.editor?.isCreate == true) CalendarMutationOperation.CREATE else CalendarMutationOperation.UPDATE,
                        target = target,
                        draft = draft,
                    )
                } else {
                    current.conflict
                }
            }
        } else {
            current.conflict
        }
        val operation = current.pendingRequest?.operation
            ?: if (current.deleteConfirmation != null) CalendarMutationOperation.DELETE
            else if (current.editor?.isCreate == true) CalendarMutationOperation.CREATE else CalendarMutationOperation.UPDATE
        val failureOutcome = if (current.editor != null || current.pendingRequest != null) {
            CalendarMutationOutcome.Failure(operation, error, current.draft, current.pendingRequest)
        } else {
            current.outcome
        }
        _state.value = _state.value.copy(
            mutation = current.copy(
                phase = when {
                    error.isConflict -> CalendarMutationPhase.CONFLICT
                    error.code == "invalid_mutation_scope" && current.deleteConfirmation != null -> CalendarMutationPhase.DELETE_CONFIRMATION
                    current.editor != null -> CalendarMutationPhase.EDITING
                    else -> current.phase
                },
                error = error,
                conflict = conflict,
                outcome = failureOutcome,
                pendingRequest = if (error.isConflict) current.pendingRequest else null,
                deleteConfirmation = if (error.code == "invalid_mutation_scope") current.deleteConfirmation else null,
            ),
        )
    }

    private fun mutationOfflineGate(): CalendarMutationError? {
        val current = _state.value
        if (accessDisabled || current.mutationAvailability.reason == CalendarMutationAvailabilityReason.AUTHORIZATION) {
            return CalendarMutationError(
                kind = CalendarMutationErrorKind.AUTHORIZATION,
                code = "authorization",
                userMessage = "This calendar action is not permitted.",
                recoverable = false,
            )
        }
        val unavailable = current.offline != CalendarOfflineState.ONLINE ||
            current.freshness.isUnavailableOffline ||
            current.freshness == CalendarFreshness.CACHED_OFFLINE ||
            current.mutationAvailability.reason == CalendarMutationAvailabilityReason.OFFLINE
        if (!unavailable) return null
        return CalendarMutationError(
            kind = CalendarMutationErrorKind.CONNECTION,
            code = "connection_required",
            userMessage = "Connect to save or delete calendar events.",
        )
    }

    private fun submitDelete(draft: CalendarMutationDraft, scope: CalendarMutationScope): Job? {
        val conflict = _state.value.mutation.conflict
        if (conflict != null && !conflict.canSubmit) {
            setMutationError(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict_review_required",
                    userMessage = "Review the latest event before deleting again.",
                ),
            )
            return null
        }
        mutationOfflineGate()?.let {
            setMutationError(it)
            return null
        }
        val built = buildCalendarDeleteRequest(draft, scope)
        val request = when (built) {
            is CalendarCommandBuildResult.Success -> built.value
            is CalendarCommandBuildResult.Failure -> {
                setMutationError(built.error)
                return null
            }
        }
        return submitRequest(request, draft)
    }

    private fun submitRequest(request: CalendarMutationRequest, draft: CalendarMutationDraft): Job {
        val current = _state.value.mutation
        _state.value = _state.value.copy(
            mutation = current.copy(
                phase = CalendarMutationPhase.SUBMITTING,
                pendingRequest = request,
                error = null,
                conflict = null,
                outcome = null,
                deleteConfirmation = null,
            ),
        )
        mutationJob?.cancel()
        val fence = captureMutationFence()
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val result: MutationTransportResult = try {
                when (request) {
                    is CalendarMutationRequest.Create -> MutationTransportResult.Create(
                        repository.create(request.input),
                    )
                    is CalendarMutationRequest.Update -> MutationTransportResult.Mutate(
                        repository.mutate(request.eventId, request.command),
                    )
                    is CalendarMutationRequest.Delete -> MutationTransportResult.Mutate(
                        repository.mutate(request.eventId, request.command),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                MutationTransportResult.Failure(
                    CalendarMutationError(
                        kind = CalendarMutationErrorKind.SERVER,
                        code = "server_error",
                        userMessage = "The calendar could not complete that action. Your draft is still here.",
                    ),
                )
            }
            if (!isMutationFenceCurrent(fence)) return@launch
            when (result) {
                is MutationTransportResult.Failure -> {
                    setMutationError(result.error)
                    _state.value = _state.value.copy(
                        mutation = _state.value.mutation.copy(
                            pendingRequest = if (result.error.isConflict) request else null,
                        ),
                    )
                }
                is MutationTransportResult.Create -> when (val envelope = result.result) {
                    is SentientResult.Success -> completeMutation(
                        operation = CalendarMutationOperation.CREATE,
                        draft = draft,
                        event = envelope.data,
                        mutation = null,
                        fence = fence,
                    )
                    is SentientResult.Failure -> handleMutationFailure(fence, mutationError(envelope.error))
                    is SentientResult.Loading -> setMutationError(
                        CalendarMutationError(
                            CalendarMutationErrorKind.SERVER,
                            "The calendar could not complete that action. Your draft is still here.",
                            code = "unsettled_result",
                        ),
                    )
                }
                is MutationTransportResult.Mutate -> when (val envelope = result.result) {
                    is SentientResult.Success -> if (validMutationResult(envelope.data, request)) {
                        completeMutation(
                            operation = request.operation,
                            draft = draft,
                            event = null,
                            mutation = envelope.data,
                            fence = fence,
                        )
                    } else {
                        setMutationError(
                            CalendarMutationError(
                                CalendarMutationErrorKind.CONTRACT,
                                "The calendar returned an invalid mutation result. Your draft is still here.",
                                code = "invalid_result",
                            ),
                        )
                    }
                    is SentientResult.Failure -> handleMutationFailure(fence, mutationError(envelope.error))
                    is SentientResult.Loading -> setMutationError(
                        CalendarMutationError(
                            CalendarMutationErrorKind.SERVER,
                            "The calendar could not complete that action. Your draft is still here.",
                            code = "unsettled_result",
                        ),
                    )
                }
            }
        }
        mutationJob = job
        job.invokeOnCompletion { if (mutationJob === job) mutationJob = null }
        return job
    }

    private fun validMutationResult(
        result: CalendarMutationResult,
        request: CalendarMutationRequest,
    ): Boolean {
        val expectedOperation = when (request.operation) {
            CalendarMutationOperation.UPDATE -> io.sentient.mobilesdk.calendar.CalendarOperation.UPDATE
            CalendarMutationOperation.DELETE -> io.sentient.mobilesdk.calendar.CalendarOperation.DELETE
            CalendarMutationOperation.CREATE -> return false
        }
        val command = when (request) {
            is CalendarMutationRequest.Update -> request.command
            is CalendarMutationRequest.Delete -> request.command
            is CalendarMutationRequest.Create -> return false
        }
        return result.operation == expectedOperation &&
            result.appliedTo == command.applyTo &&
            result.eventId.isNotBlank() &&
            result.resultingRevision?.let { it >= 0 } != false &&
            result.successorEventId?.isNotBlank() != false
    }

    private suspend fun completeMutation(
        operation: CalendarMutationOperation,
        draft: CalendarMutationDraft,
        event: CalendarEvent?,
        mutation: CalendarMutationResult?,
        fence: MutationContinuationFence,
    ) {
        if (!isMutationFenceCurrent(fence)) return
        // The editor lifecycle ends on success. The outcome remains until the
        // native surface acknowledges it, while valid cached rows stay visible.
        val successor = mutation?.successorEventId?.takeIf(String::isNotBlank)
        val affected = affectedWindowsForMutation(fence) ?: return
        if (!isMutationFenceCurrent(fence)) return
        val success = CalendarMutationSuccess(
            operation = operation,
            event = event,
            mutation = mutation,
            successorEventId = successor,
            affectedWindows = affected,
        )
        _state.value = _state.value.copy(
            mutation = _state.value.mutation.copy(
                phase = CalendarMutationPhase.OUTCOME,
                preview = null,
                editor = null,
                deleteConfirmation = null,
                pendingRequest = null,
                error = null,
                conflict = null,
                outcome = CalendarMutationOutcome.Success(operation, success),
                successorEventId = successor,
                affectedWindows = affected,
            ),
        )
        revalidateMutationWindows(affected, fence)
    }

    private suspend fun affectedWindowsForMutation(
        fence: MutationContinuationFence,
    ): List<CalendarCacheWindow>? {
        if (!isMutationFenceCurrent(fence)) return null
        val windows = linkedSetOf(activeWindow)
        val metadata = try {
            cacheStore.readWindows()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
            )
        }
        if (!isMutationFenceCurrent(fence)) return null
        if (metadata is CalendarCacheResult.Success && isNamespaceCurrent(fence.namespace, fence.namespaceGeneration)) {
            windows += metadata.value.map { it.window }
        }
        return windows.toList()
    }

    private fun revalidateMutationWindows(
        affectedWindows: List<CalendarCacheWindow>,
        fence: MutationContinuationFence,
    ) {
        if (!isMutationFenceCurrent(fence)) return
        // Use the normal foreground path so failures retain visible content and
        // the finalized cached/offline state remains the single write gate. A
        // mutation must not merely join a refresh that started before its write.
        forceRevalidateAfterMutation(fence)
        if (!isMutationFenceCurrent(fence)) return
        mutationRefreshJob?.cancel()
        val namespace = fence.namespace
        val epoch = fence.namespaceGeneration
        val active = activeWindow
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            affectedWindows.forEach { window ->
                if (window == active || !isMutationFenceCurrent(fence)) return@forEach
                when (loadWindow(window, namespace, epoch, fence)) {
                    WindowLoadResult.Cancelled -> Unit
                    is WindowLoadResult.Complete,
                    is WindowLoadResult.Failed,
                    -> Unit
                }
            }
        }
        mutationRefreshJob = job
        job.invokeOnCompletion { if (mutationRefreshJob === job) mutationRefreshJob = null }
    }

    private fun forceRevalidateAfterMutation(fence: MutationContinuationFence) {
        if (!isMutationFenceCurrent(fence) || accessDisabled) return
        if (observationJob?.isActive != true) {
            observe(requestedWindow)
            return
        }
        refreshJob?.cancel()
        refreshJob = null
        revalidationGeneration = null
        cancelPrefetchWork()
        cancelSharedRequests()
        if (!isMutationFenceCurrent(fence)) return
        val generation = requestGeneration
        val namespace = fence.namespace
        val epoch = fence.namespaceGeneration
        revalidationGeneration = generation
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            if (isMutationFenceCurrent(fence)) revalidate(activeWindow, generation, namespace, epoch)
        }
        refreshJob = job
        job.invokeOnCompletion { if (refreshJob === job) refreshJob = null }
    }

    private fun mutationError(error: SentientError): CalendarMutationError {
        val message = error.userMessage.lowercase()
        return when (error) {
            is SentientError.Connection,
            is SentientError.Timeout,
            -> CalendarMutationError(
                kind = CalendarMutationErrorKind.CONNECTION,
                code = "connection",
                userMessage = "Connect to save or delete calendar events.",
            )
            is SentientError.Auth -> CalendarMutationError(
                kind = CalendarMutationErrorKind.AUTHORIZATION,
                code = "authorization",
                userMessage = "This calendar action is not permitted.",
                recoverable = false,
            )
            is SentientError.Protocol -> when {
                ("recurrence" in message || "recurring" in message) && ("conflict" in message || "changed" in message || "could not" in message) -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.RECURRENCE_CONFLICT,
                    code = "recurrence_conflict",
                    userMessage = "This recurring event changed. Review the latest version before saving.",
                )
                "conflict" in message || "changed" in message || "revision" in message -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    code = "conflict",
                    userMessage = "This event changed. Review the latest version before saving.",
                )
                "forbidden" in message || "permission" in message || "not permitted" in message -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.FORBIDDEN,
                    code = "forbidden",
                    userMessage = "This calendar action is not permitted.",
                )
                "not found" in message || "no longer available" in message || "occurrence_not_found" in message -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.NOT_FOUND,
                    code = "not_found",
                    userMessage = "This calendar event is no longer available.",
                )
                "invalid response" in message -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.SERVER,
                    code = "malformed",
                    userMessage = "The calendar could not complete that action. Your draft is still here.",
                )
                "invalid" in message || "range" in message || "scope" in message || "recurrence" in message -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.VALIDATION,
                    code = "validation",
                    userMessage = "Check the event details and try again.",
                )
                else -> CalendarMutationError(
                    kind = CalendarMutationErrorKind.SERVER,
                    code = "server_error",
                    userMessage = "The calendar could not complete that action. Your draft is still here.",
                )
            }
            is SentientError.Cycle -> CalendarMutationError(
                CalendarMutationErrorKind.SERVER,
                "The calendar could not complete that action. Your draft is still here.",
                code = "server_error",
            )
            is SentientError.Outbox,
            is SentientError.Unknown,
            -> CalendarMutationError(
                CalendarMutationErrorKind.SERVER,
                "The calendar could not complete that action. Your draft is still here.",
                code = "server_error",
            )
        }
    }

    private fun handleMutationFailure(
        fence: MutationContinuationFence,
        error: CalendarMutationError,
    ) {
        if (!isMutationFenceCurrent(fence)) return
        if (error.kind == CalendarMutationErrorKind.AUTHORIZATION) {
            scheduleAuthenticationExpiry(fence)
        } else {
            setMutationError(error)
        }
    }

    private fun forbiddenMutationReadError() = CalendarExperienceError(
        kind = CalendarExperienceErrorKind.FORBIDDEN,
        userMessage = "This calendar event is no longer available.",
        recoverable = false,
    )

    private fun captureMutationFence(): MutationContinuationFence {
        mutationGeneration += 1L
        return MutationContinuationFence(
            namespace = cacheStore.currentNamespace.value,
            namespaceGeneration = namespaceGeneration,
            mutationGeneration = mutationGeneration,
        )
    }

    private fun isMutationFenceCurrent(fence: MutationContinuationFence): Boolean =
        !closed &&
            mutationGeneration == fence.mutationGeneration &&
            namespaceGeneration == fence.namespaceGeneration &&
            cacheStore.currentNamespace.value == fence.namespace

    /** Schedules auth teardown with registration before start. */
    private fun scheduleAuthenticationExpiry(fence: MutationContinuationFence) {
        if (!isMutationFenceCurrent(fence) || authExpiryJob?.let { !it.isCompleted } == true) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (isMutationFenceCurrent(fence)) expireAuthenticationInternal(cancelAuthExpiry = false)
        }
        authExpiryJob = job
        job.invokeOnCompletion { if (authExpiryJob === job) authExpiryJob = null }
        job.start()
    }

    private fun scheduleAuthenticationExpiry(
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ) {
        if (!isNamespaceCurrent(namespace, namespaceEpoch) || authExpiryJob?.let { !it.isCompleted } == true) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (isNamespaceCurrent(namespace, namespaceEpoch)) {
                expireAuthenticationInternal(cancelAuthExpiry = false)
            }
        }
        authExpiryJob = job
        job.invokeOnCompletion { if (authExpiryJob === job) authExpiryJob = null }
        job.start()
    }

    private fun scheduleAuthenticationExpiry(
        generation: Long,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ) {
        if (!isCurrent(generation, namespace, namespaceEpoch) || authExpiryJob?.let { !it.isCompleted } == true) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            if (isCurrent(generation, namespace, namespaceEpoch)) {
                expireAuthenticationInternal(cancelAuthExpiry = false)
            }
        }
        authExpiryJob = job
        job.invokeOnCompletion { if (authExpiryJob === job) authExpiryJob = null }
        job.start()
    }

    /** Clears state synchronously, then purges the forbidden namespace. */
    private fun scheduleForbiddenPurge(
        namespace: CalendarCacheNamespace,
        error: CalendarExperienceError,
    ) {
        if (closed || !isNamespaceCurrent(namespace, namespaceGeneration)) return
        accessDisabled = true
        invalidateForNamespace(namespace)
        _state.value = _state.value.copy(
            freshness = CalendarFreshness.ERROR,
            offline = CalendarOfflineState.ONLINE,
            error = error,
            mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.AUTHORIZATION),
        )
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            purgeNamespaceSafely(namespace)
        }
    }

    private suspend fun purgeNamespaceSafely(namespace: CalendarCacheNamespace): CalendarCacheResult<Unit> =
        withContext(NonCancellable) {
            try {
                cacheStore.purgeNamespace(namespace)
            } catch (_: Throwable) {
                CalendarCacheResult.Failure(
                    io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
                )
            }
        }

    private sealed interface MutationTransportResult {
        data class Create(val result: SentientResult<CalendarEvent>) : MutationTransportResult
        data class Mutate(val result: SentientResult<CalendarMutationResult>) : MutationTransportResult
        data class Failure(val error: CalendarMutationError) : MutationTransportResult
    }

    fun dispatch(action: CalendarNavigationAction) {
        if (closed) return
        val normalizedAction = try {
            when (action) {
                is CalendarNavigationAction.SetFilters -> action.copy(filters = validateFilters(action.filters))
                else -> action
            }
        } catch (_: IllegalArgumentException) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.CONTRACT,
                    userMessage = "The selected calendar filters are invalid.",
                ),
            )
            return
        }
        val current = _state.value
        val next = try {
            CalendarNavigation.reduce(current, normalizedAction).state
        } catch (_: IllegalArgumentException) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.CONTRACT,
                    userMessage = "The selected calendar position is invalid.",
                ),
            )
            return
        }
        val actionForWindow = normalizedAction
        applyPresentation(next)
        persistPresentation(next)

        // Filters are purely local over the complete cached set. View/date/locale
        // changes can alter the visible interval and are the only intents that
        // start a new foreground window request.
        val requiresWindow = actionForWindow !is CalendarNavigationAction.SetFilters
        val desiredWindow = windowFor(next)
        if (requiresWindow && desiredWindow != activeWindow) observe(desiredWindow)
    }

    fun send(action: CalendarNavigationAction) = dispatch(action)
    fun onIntent(action: CalendarNavigationAction) = dispatch(action)

    fun today() = dispatch(CalendarNavigationAction.Today)
    fun previous() = dispatch(CalendarNavigationAction.Previous)
    fun next() = dispatch(CalendarNavigationAction.Next)
    fun selectDate(date: String) = dispatch(CalendarNavigationAction.SelectDate(date))
    fun selectMonth(year: Int, month: Int) = dispatch(CalendarNavigationAction.SelectMonth(year, month))
    fun selectView(view: CalendarView) = dispatch(CalendarNavigationAction.SelectView(view))
    fun setFilters(filters: CalendarFilters) = dispatch(CalendarNavigationAction.SetFilters(filters))
    fun setLocale(locale: CalendarLocale) = dispatch(CalendarNavigationAction.SetLocale(locale))

    /**
     * Coalesced explicit revalidation. The returned Job is useful to tests and
     * lifecycle owners; callers may ignore it when observation is long-lived.
     */
    fun refresh(): Job? {
        if (closed || accessDisabled) return null
        preparePrefetchForRecovery()
        if (observationJob?.isActive != true) {
            observe(requestedWindow)
        }
        refreshJob?.takeIf { it.isActive }?.let { return it }
        val generation = requestGeneration
        val namespace = cacheStore.currentNamespace.value
        val namespaceEpoch = namespaceGeneration
        // The foreground observation may still be loading its preference/cache
        // flows. Let that same job launch the first revalidation after its
        // cache-first emission instead of racing it with a second request.
        if (observationJob?.isActive == true && revalidationGeneration != generation) {
            return observationJob
        }
        val window = activeWindow
        revalidationGeneration = generation
        val job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            revalidate(window, generation, namespace, namespaceEpoch)
        }
        refreshJob = job
        job.invokeOnCompletion {
            if (refreshJob === job) refreshJob = null
        }
        return job
    }

    fun refresh(window: CalendarCacheWindow): Job? {
        if (activeWindow != window || observationJob?.isActive != true) observe(window)
        return refresh()
    }

    fun refreshNow(): Job? = refresh()
    fun revalidate(window: CalendarCacheWindow): Job? = refresh(window)

    /** Connectivity is deliberately a caller signal; revalidation remains shared. */
    fun onConnectivityRecovered(): Job? = refresh()
    fun connectivityRecovered(): Job? = onConnectivityRecovered()
    fun recoverFromOffline(): Job? = onConnectivityRecovered()

    /**
     * Schedules the current calendar month and its adjacent months. This is a
     * convenience seam for deterministic tests and lifecycle adapters; normal
     * observation schedules the same work automatically.
     */
    fun prefetchAdjacent(window: CalendarCacheWindow = activeWindow): List<Job> {
        if (closed || accessDisabled) return emptyList()
        preparePrefetchForRecovery()
        val coordinator = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            scheduleAdjacentPrefetch(
                window = window,
                namespace = cacheStore.currentNamespace.value,
                namespaceEpoch = namespaceGeneration,
            )
        }
        return listOf(coordinator)
    }

    val isPrefetching: Boolean
        get() {
            if (!bookkeepingMutex.tryLock()) return true
            return try {
                prefetchJobs.values.any { !it.job.isCompleted }
            } finally {
                bookkeepingMutex.unlock()
            }
        }

    /** Stop all foreground/cache work without closing a caller-owned session scope. */
    fun close() {
        if (closed) return
        closed = true
        requestGeneration += 1L
        namespaceGeneration += 1L
        mutationGeneration += 1L
        observationJob?.cancel()
        refreshJob?.cancel()
        mutationJob?.cancel()
        mutationRefreshJob?.cancel()
        preferenceWriteJob?.cancel()
        cancelAccessWriteJobs()
        namespaceJob?.cancel()
        authExpiryJob?.cancel()
        cancelPrefetchWork()
        cancelSharedRequests()
        unregisterNamespaceListener?.invoke()
        observationJob = null
        refreshJob = null
        mutationJob = null
        mutationRefreshJob = null
        namespaceJob = null
        unregisterNamespaceListener = null
        revalidationGeneration = null
        preferenceWriteJob = null
        authExpiryJob = null
        _prefetchDiagnostics.value = emptyList()
        _state.value = initialState.copy(
            freshness = CalendarFreshness.STALE,
            offline = CalendarOfflineState.UNAVAILABLE,
            error = null,
            hasCompleteCache = false,
            cachedWindow = null,
            authorizedOccurrences = emptyList(),
            projection = null,
            facets = emptyCalendarFacets(),
            loading = CalendarLoadingState(),
            persistedCachePreferences = null,
            mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.UNAVAILABLE),
            mutation = CalendarMutationState(),
        )
    }

    /**
     * Switch the authenticated cache namespace through the experience boundary.
     * The visible state is cleared before the store can emit the successor
     * namespace, and every old request is epoch-invalidated. Session owners
     * should use this seam rather than switching the store behind the active
     * experience; the namespace watcher below still protects direct store users.
     */
    suspend fun switchNamespace(
        namespace: CalendarCacheNamespace,
        purgePrevious: Boolean = true,
    ): CalendarCacheResult<Unit> {
        if (closed) {
            return CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.CLOSED),
            )
        }
        if (namespace == cacheStore.currentNamespace.value) return CalendarCacheResult.Success(Unit)

        invalidateForNamespace(namespace)
        val result = try {
            cacheStore.switchNamespace(namespace, purgePrevious)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
            )
        }
        if (result is CalendarCacheResult.Success && !closed && cacheStore.currentNamespace.value == namespace) {
            observe(requestedWindow)
        } else if (result is CalendarCacheResult.Failure && !closed && cacheStore.currentNamespace.value != namespace) {
            // The old namespace remains safe to reload; do not leave the
            // experience permanently blank after a failed switch attempt.
            handleNamespaceChange(cacheStore.currentNamespace.value)
        }
        return result
    }

    /** Purges through the experience boundary so active work is cancelled first. */
    suspend fun purgeNamespace(
        namespace: CalendarCacheNamespace = cacheStore.currentNamespace.value,
    ): CalendarCacheResult<Unit> {
        if (closed) {
            return CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.CLOSED),
            )
        }
        if (namespace == cacheStore.currentNamespace.value) invalidateForNamespace(namespace)
        return purgeNamespaceSafely(namespace)
    }

    /**
     * Auth expiry is a private-data boundary, not merely a visible error. The
     * successor auth root can therefore never observe the old cache or a
     * still-running adjacent request.
     */
    suspend fun expireAuthentication(): CalendarCacheResult<Unit> =
        expireAuthenticationInternal(cancelAuthExpiry = true)

    private suspend fun expireAuthenticationInternal(
        cancelAuthExpiry: Boolean,
    ): CalendarCacheResult<Unit> {
        if (closed) {
            return CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.CLOSED),
            )
        }
        val namespace = cacheStore.currentNamespace.value
        // invalidateForNamespace cancels the transport and collector first. It
        // must not cancel the expiry continuation that is about to purge.
        invalidateForNamespace(namespace, cancelAuthExpiry = cancelAuthExpiry)
        val invalidatedEpoch = namespaceGeneration
        val result = purgeNamespaceSafely(namespace)
        // A successor namespace may have been selected while the old namespace
        // was being purged. The old auth continuation must not close that
        // successor experience or driver.
        if (!closed && namespaceGeneration == invalidatedEpoch && cacheStore.currentNamespace.value == namespace) {
            // Close even when the purge reports a database failure: an expired
            // session must not retain an active experience boundary.
            close()
            cacheStore.close()
        }
        return result
    }

    suspend fun onAuthenticationExpired(): CalendarCacheResult<Unit> = expireAuthentication()

    /** Authenticated-session teardown: cancel, purge, then close the driver. */
    suspend fun disposeAndPurge(): CalendarCacheResult<Unit> {
        val result = if (closed) {
            CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.CLOSED),
            )
        } else {
            purgeNamespace()
        }
        close()
        cacheStore.close()
        return result
    }

    private suspend fun runObservation(
        requested: CalendarCacheWindow,
        generation: Long,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ) {
        // Preferences are read before selecting the first window so a restored
        // Month/Week/Day/Year view is the first remote request, not a follow-up.
        val preferenceRead = readPreferencesSafely(namespace)
        val restored = when (preferenceRead) {
            is CalendarCacheResult.Success -> preferenceRead.value?.let(::validatePreferences)
            is CalendarCacheResult.Failure -> null
        }
        if (!isCurrent(generation, namespace, namespaceEpoch)) return

        if (preferenceRead is CalendarCacheResult.Failure) {
            updateError(cacheFailure(preferenceRead.error.reason))
        } else if (preferenceRead is CalendarCacheResult.Success && preferenceRead.value != null && restored == null) {
            updateError(
                CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.DECODE,
                    userMessage = "Saved calendar preferences could not be read.",
                ),
            )
        }

        val selectedWindow = restored?.let {
            windowFor(
                presentation = presentationFor(it),
                timezoneInput = requested.timezoneInput,
            )
        } ?: requested

        if (!isCurrent(generation, namespace, namespaceEpoch)) return
        requestedWindow = selectedWindow
        activeWindow = selectedWindow
        if (restored != null) applyRestoredPreferences(restored, selectedWindow)
        observeWindow(selectedWindow, generation, namespace, namespaceEpoch, restored)
    }

    private suspend fun observeWindow(
        window: CalendarCacheWindow,
        generation: Long,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        restored: CalendarCachePreferences?,
    ) = coroutineScope {
        val cacheReady = CompletableDeferred<Unit>()
        var latestSnapshot: CalendarCacheSnapshot? = null
        var hasSeenSnapshot = false
        var lastAppliedFetchedAt: Long? = null
        var latestPreferences: CalendarCachePreferences? = restored
        var hasSeenPreferences = restored != null

        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                combine(
                    cacheStore.observeSnapshot(window),
                    cacheStore.observePreferences(),
                ) { snapshot, preferences -> CacheInputs(snapshot, preferences) }
                    .collect { inputs ->
                        if (!isCurrent(generation, namespace, namespaceEpoch)) return@collect
                        val snapshotResult = inputs.snapshot
                        val preferencesResult = inputs.preferences

                        if (preferencesResult is CalendarCacheResult.Success) {
                            hasSeenPreferences = true
                            val normalized = preferencesResult.value?.let(::validatePreferences)
                            if (preferencesResult.value != null && normalized == null) {
                                updateError(
                                    CalendarExperienceError(
                                        kind = CalendarExperienceErrorKind.DECODE,
                                        userMessage = "Saved calendar preferences could not be read.",
                                    ),
                                )
                            } else if (normalized != null) {
                                latestPreferences = normalized
                            } else {
                                latestPreferences = null
                            }
                        } else if (preferencesResult is CalendarCacheResult.Failure) {
                            updateError(cacheFailure(preferencesResult.error.reason))
                        }

                        if (snapshotResult is CalendarCacheResult.Success) {
                            hasSeenSnapshot = true
                            // A successful null is a real empty result for this
                            // namespace/window, not permission to retain the
                            // predecessor's snapshot in a local accumulator.
                            latestSnapshot = snapshotResult.value
                        } else if (snapshotResult is CalendarCacheResult.Failure) {
                            updateError(cacheFailure(snapshotResult.error.reason))
                        }

                        val snapshotChanged = latestSnapshot?.fetchedAt != lastAppliedFetchedAt
                        if (snapshotChanged) lastAppliedFetchedAt = latestSnapshot?.fetchedAt
                        applyCacheData(
                            window = window,
                            snapshot = latestSnapshot,
                            preferences = latestPreferences,
                            hasSeenPreferences = hasSeenPreferences,
                            hasSeenSnapshot = hasSeenSnapshot,
                            snapshotChanged = snapshotChanged,
                        )
                        if (snapshotChanged && latestSnapshot != null) {
                            recordViewedWindow(
                                snapshot = latestSnapshot!!,
                                generation = generation,
                                namespace = namespace,
                                namespaceEpoch = namespaceEpoch,
                            )
                        }
                        cacheReady.complete(Unit)
                    }
            } catch (cancelled: CancellationException) {
                cacheReady.cancel(cancelled)
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                cacheReady.cancel(cancelled)
                throw cancelled
            } catch (_: Throwable) {
                if (!cacheReady.isCompleted) cacheReady.complete(Unit)
                updateError(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.DATABASE,
                        userMessage = "Calendar cache is unavailable.",
                    ),
                )
            }
        }

        cacheReady.await()
        if (!isCurrent(generation, namespace, namespaceEpoch) || !isActive) return@coroutineScope

        // A cache emission is now visible (including a typed empty result) before
        // any network call begins. This is the cache-first ordering contract.
        revalidationGeneration = generation
        val refresh = launch(start = CoroutineStart.UNDISPATCHED) {
            revalidate(window, generation, namespace, namespaceEpoch)
        }
        refreshJob = refresh
        refresh.invokeOnCompletion {
            if (refreshJob === refresh) refreshJob = null
        }
        // Adjacent work is deliberately launched after the visible cache
        // emission and foreground request have started. It never participates
        // in the visible loading state or its failure path.
        scheduleAdjacentPrefetch(window, namespace, namespaceEpoch)

        try {
            awaitCancellation()
        } finally {
            collector.cancel()
            if (refreshJob === refresh) refreshJob = null
        }
    }

    private suspend fun revalidate(
        window: CalendarCacheWindow,
        generation: Long,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ) {
        if (!isCurrent(generation, namespace, namespaceEpoch)) return
        val hasCachedContent = _state.value.hasCompleteCache
        val retainedCacheError = _state.value.error?.takeIf {
            !hasCachedContent && it.kind in setOf(
                CalendarExperienceErrorKind.DECODE,
                CalendarExperienceErrorKind.DATABASE,
            )
        }
        _state.value = _state.value.copy(
            loading = CalendarLoadingState(
                if (hasCachedContent) CalendarLoadingPhase.REFRESHING else CalendarLoadingPhase.LOADING,
            ),
            freshness = CalendarFreshness.REFRESHING,
            offline = CalendarOfflineState.ONLINE,
            error = retainedCacheError,
            mutationAvailability = CalendarMutationAvailability(
                canCreate = hasCachedContent,
                canEdit = hasCachedContent,
                canDelete = hasCachedContent,
            ),
        )

        when (val loaded = loadWindow(window, namespace, namespaceEpoch)) {
            WindowLoadResult.Cancelled -> return
            is WindowLoadResult.Failed -> {
                if (!isCurrent(generation, namespace, namespaceEpoch)) return
                if (loaded.error.kind == CalendarExperienceErrorKind.AUTHORIZATION) {
                    scheduleAuthenticationExpiry(generation, namespace, namespaceEpoch)
                    return
                }
                if (loaded.error.kind == CalendarExperienceErrorKind.FORBIDDEN) {
                    // A forbidden refresh invalidates the old projection before
                    // purging the namespace; cached private content is never a
                    // fallback after an authorization boundary.
                    scheduleForbiddenPurge(namespace, loaded.error)
                    return
                }
                val hasCache = _state.value.hasCompleteCache
                val connection = loaded.error.kind == CalendarExperienceErrorKind.CONNECTION
                val resultingError = if (connection && !hasCache) {
                    unavailableOfflineError()
                } else {
                    loaded.error
                }
                val resultingFreshness = if (connection) {
                    if (hasCache) CalendarFreshness.CACHED_OFFLINE else CalendarFreshness.UNAVAILABLE_OFFLINE
                } else {
                    CalendarFreshness.ERROR
                }
                if (hasCache) persistFreshness(namespace, window, namespaceEpoch, resultingFreshness)
                _state.value = _state.value.copy(
                    loading = CalendarLoadingState(),
                    freshness = resultingFreshness,
                    offline = if (connection) {
                        if (hasCache) CalendarOfflineState.OFFLINE else CalendarOfflineState.UNAVAILABLE
                    } else {
                        CalendarOfflineState.ONLINE
                    },
                    error = resultingError,
                    mutationAvailability = unavailableMutationAvailability(
                        if (connection) CalendarMutationAvailabilityReason.OFFLINE
                        else if (loaded.error.kind == CalendarExperienceErrorKind.AUTHORIZATION || loaded.error.kind == CalendarExperienceErrorKind.FORBIDDEN) {
                            CalendarMutationAvailabilityReason.AUTHORIZATION
                        } else CalendarMutationAvailabilityReason.ERROR,
                    ),
                )
            }

            is WindowLoadResult.Complete -> {
                if (!isCurrent(generation, namespace, namespaceEpoch)) return
                // The SQLDelight flow naturally emits this generation. We also
                // apply it here so lightweight injected stores that acknowledge
                // writes before emitting expose a complete value immediately.
                applyCommittedData(window, loaded.occurrences, loaded.fetchedAt)
                scheduleAdjacentPrefetch(window, namespace, namespaceEpoch)
            }
        }
    }

    /**
     * One shared load owns pagination and the complete-page replacement. Both
     * foreground revalidation and adjacent prefetch await this entry so an
     * equivalent request cannot issue a second remote read or a second commit.
     */
    private suspend fun loadWindow(
        window: CalendarCacheWindow,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        continuationFence: MutationContinuationFence? = null,
    ): WindowLoadResult {
        if (!isNamespaceCurrent(namespace, namespaceEpoch) ||
            continuationFence != null && !isMutationFenceCurrent(continuationFence)
        ) return WindowLoadResult.Cancelled
        val key = CalendarWindowRequestKey(namespace, window)
        // Registration and the LAZY start are deliberately separate: a fast
        // completion cannot occur before a coalescing entry is visible. The
        // atomic registry also makes cancellation/removal linear with lookup,
        // even though this public operation may be initiated synchronously.
        val request = registerInFlightRequest(key, window, namespace, namespaceEpoch, continuationFence)
            ?: return WindowLoadResult.Cancelled
        request.start()
        val result = request.await()
        return if (continuationFence == null || isMutationFenceCurrent(continuationFence)) result
        else WindowLoadResult.Cancelled
    }

    private fun registerInFlightRequest(
        key: CalendarWindowRequestKey,
        window: CalendarCacheWindow,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        continuationFence: MutationContinuationFence?,
    ): Deferred<WindowLoadResult>? {
        while (true) {
            if (!isNamespaceCurrent(namespace, namespaceEpoch) ||
                continuationFence != null && !isMutationFenceCurrent(continuationFence)
            ) return null
            val registry = inFlightRequests.load()
            val existing = registry.entries[key]
            if (existing != null &&
                existing.bookkeepingGeneration == registry.generation &&
                existing.deferred.isActive
            ) {
                return existing.deferred
            }

            // Keep the new Deferred lazy until its exact entry is installed.
            // If cancellation wins the CAS, this object is never reusable.
            val created = scope.async(start = CoroutineStart.LAZY) {
                loadWindowUncoalesced(window, namespace, namespaceEpoch, continuationFence)
            }
            val nextEntries = registry.entries.toMutableMap()
            nextEntries[key] = InFlightRequestRegistration(registry.generation, created)
            val next = InFlightRequestRegistry(registry.generation, nextEntries.toMap())
            if (inFlightRequests.compareAndSet(registry, next)) {
                // Remove/cancel the predecessor only after the replacement is
                // published. Its completion callback compares identity and can
                // therefore never erase this replacement.
                if (existing != null) existing.deferred.cancel()
                created.invokeOnCompletion { removeInFlightRequest(key, created) }
                return created
            }
            // Another registrar or cancellation won the linearization point.
            // This lazy child has not performed remote work and is disposable.
            created.cancel()
        }
    }

    private fun removeInFlightRequest(
        key: CalendarWindowRequestKey,
        completed: Deferred<WindowLoadResult>,
    ) {
        while (true) {
            val registry = inFlightRequests.load()
            if (registry.entries[key]?.deferred !== completed) return
            val nextEntries = registry.entries.toMutableMap()
            nextEntries.remove(key)
            val next = registry.copy(entries = nextEntries.toMap())
            if (inFlightRequests.compareAndSet(registry, next)) return
        }
    }

    private suspend fun loadWindowUncoalesced(
        window: CalendarCacheWindow,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        continuationFence: MutationContinuationFence? = null,
    ): WindowLoadResult {
        return when (val aggregation = aggregate(window, null, namespace, namespaceEpoch, continuationFence)) {
            AggregationResult.Cancelled -> WindowLoadResult.Cancelled
            is AggregationResult.Failed -> WindowLoadResult.Failed(aggregation.error)
            is AggregationResult.Complete -> {
                if (!isNamespaceCurrent(namespace, namespaceEpoch) ||
                    continuationFence != null && !isMutationFenceCurrent(continuationFence)
                ) return WindowLoadResult.Cancelled
                val fetchedAt = nowMillis().coerceAtLeast(0L)
                val isViewedWindow = activeWindow == window && isNamespaceCurrent(namespace, namespaceEpoch)
                val lastAccessedAt = if (isViewedWindow) fetchedAt else previousAccessedAt(namespace, namespaceEpoch, window)
                if (continuationFence != null && !isMutationFenceCurrent(continuationFence)) return WindowLoadResult.Cancelled
                val protectedWindow = activeWindow.takeIf {
                    !closed && cacheStore.currentNamespace.value == namespace
                } ?: window
                val writeResult = try {
                    cacheStore.replaceSnapshotAndRetainForNamespace(
                        namespace = namespace,
                        window = window,
                        occurrences = aggregation.occurrences,
                        fetchedAt = fetchedAt,
                        lastAccessedAt = lastAccessedAt,
                        freshness = CalendarCacheFreshness.FRESH,
                        activeWindow = protectedWindow,
                        maxWindows = io.sentient.mobiledata.cache.CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (cancelled: KotlinCancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    CalendarCacheResult.Failure(
                        io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
                    )
                }
                when (writeResult) {
                    is CalendarCacheResult.Success -> if (continuationFence == null || isMutationFenceCurrent(continuationFence)) {
                        WindowLoadResult.Complete(aggregation.occurrences, fetchedAt)
                    } else {
                        WindowLoadResult.Cancelled
                    }
                    is CalendarCacheResult.Failure -> WindowLoadResult.Failed(cacheFailure(writeResult.error.reason))
                }
            }
        }
    }

    private suspend fun aggregate(
        window: CalendarCacheWindow,
        generation: Long?,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        continuationFence: MutationContinuationFence? = null,
    ): AggregationResult {
        val byIdentity = LinkedHashMap<String, EffectiveOccurrence>()
        val occurrenceIds = HashMap<String, String>()
        val seenCursors = HashSet<String>()
        var cursor: String? = null
        var pageCount = 0

        while (true) {
            if (!isRequestCurrent(generation, namespace, namespaceEpoch) ||
                continuationFence != null && !isMutationFenceCurrent(continuationFence)
            ) return AggregationResult.Cancelled
            if (++pageCount > MAX_PAGES) {
                return AggregationResult.Failed(contractError("Calendar pagination exceeded its safety bound."))
            }

            val result = try {
                repository.list(
                    from = window.windowStart,
                    to = window.windowEnd,
                    scope = CalendarScope.ALL,
                    group = null,
                    tags = null,
                    importance = null,
                    cursor = cursor,
                    query = null,
                    limit = null,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.CONNECTION,
                        userMessage = "Network unavailable. Cached calendar data is still shown.",
                    ),
                )
            }
            if (!isRequestCurrent(generation, namespace, namespaceEpoch) ||
                continuationFence != null && !isMutationFenceCurrent(continuationFence)
            ) return AggregationResult.Cancelled
            val page = when (result) {
                is SentientResult.Success -> result.data
                is SentientResult.Failure -> return AggregationResult.Failed(repositoryError(result.error))
                is SentientResult.Loading -> return AggregationResult.Failed(contractError("Calendar pagination did not return a settled page."))
            }

            if (!isRequestCurrent(generation, namespace, namespaceEpoch) ||
                continuationFence != null && !isMutationFenceCurrent(continuationFence)
            ) return AggregationResult.Cancelled
            val converted = try {
                convertPage(page)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: MalformedCalendarPageException) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.MALFORMED,
                        userMessage = "The calendar returned an invalid response.",
                    ),
                )
            } catch (_: Throwable) {
                return AggregationResult.Failed(
                    CalendarExperienceError(
                        kind = CalendarExperienceErrorKind.DECODE,
                        userMessage = "The calendar response could not be decoded.",
                    ),
                )
            }

            try {
                converted.occurrences.forEach { occurrence ->
                    val identity = CalendarOccurrenceIdentity(
                        eventId = occurrence.eventId,
                        occurrenceId = occurrence.occurrenceId,
                        originalStart = occurrence.originalStart,
                        scope = occurrence.scope,
                    )
                    val priorId = occurrenceIds[occurrence.occurrenceId]
                    if (priorId != null && priorId != identity.stableKey) {
                        throw ContractViolationException()
                    }
                    occurrenceIds[occurrence.occurrenceId] = identity.stableKey
                    val prior = byIdentity[identity.stableKey]
                    if (prior == null || occurrenceWins(occurrence, prior)) {
                        byIdentity[identity.stableKey] = occurrence
                    }
                }
            } catch (_: ContractViolationException) {
                return AggregationResult.Failed(contractError("Calendar pagination returned conflicting occurrence identity."))
            }

            val nextCursor = converted.nextCursor
            if (nextCursor == null) break
            if (nextCursor.isBlank() || !seenCursors.add(nextCursor)) {
                return AggregationResult.Failed(contractError("Calendar pagination returned a cursor loop."))
            }
            cursor = nextCursor
        }

        return AggregationResult.Complete(
            byIdentity.values.sortedWith(
                compareBy<EffectiveOccurrence> { it.start }
                    .thenBy { it.eventId }
                    .thenBy { it.occurrenceId },
            ),
        )
    }

    private suspend fun previousAccessedAt(
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
        window: CalendarCacheWindow,
    ): Long = try {
        if (!isNamespaceCurrent(namespace, namespaceEpoch)) return 0L
        when (val existing = cacheStore.readSnapshot(window)) {
            is CalendarCacheResult.Success -> existing.value?.lastAccessedAt ?: 0L
            is CalendarCacheResult.Failure -> 0L
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (cancelled: KotlinCancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        0L
    }

    private fun convertPage(page: CalendarEventPage): EffectiveOccurrencePage {
        if (page.nextCursor?.isBlank() == true) throw MalformedCalendarPageException()
        return EffectiveOccurrencePage(
            occurrences = page.events.map(::toEffectiveOccurrence),
            nextCursor = page.nextCursor,
        )
    }

    private fun toEffectiveOccurrence(event: CalendarEvent): EffectiveOccurrence {
        val eventId = event.eventId
        val occurrenceId = event.occurrenceId ?: eventId
        val start = event.start.toWireValue()
        val originalStart = event.originalStart?.toWireValue() ?: start
        val end = event.end?.toWireValue()
        if (eventId.isBlank() || occurrenceId.isBlank() || originalStart.isBlank() || start.isBlank()) {
            throw MalformedCalendarPageException()
        }
        if (event.revision < 0 || end?.isBlank() == true) throw MalformedCalendarPageException()
        validateTemporal(originalStart)
        validateTemporal(start)
        end?.let(::validateTemporal)
        return EffectiveOccurrence(
            eventId = eventId,
            occurrenceId = occurrenceId,
            originalStart = originalStart,
            recurring = event.recurring || event.recurrence != null ||
                event.originalStart?.toWireValue()?.let { it != start } == true,
            revision = event.revision,
            scope = event.scope,
            title = event.title,
            description = event.description,
            start = start,
            end = end,
            visibility = event.visibility,
            importance = event.importance,
            group = event.group,
            tags = event.tags,
            recurrence = event.recurrence,
        )
    }

    private fun validateTemporal(value: String) {
        if (CalendarDates.isValid(value)) return
        try {
            parseCalendarInstant(value)
        } catch (_: IllegalArgumentException) {
            throw MalformedCalendarPageException()
        }
    }

    private fun occurrenceWins(candidate: EffectiveOccurrence, prior: EffectiveOccurrence): Boolean =
        compareValuesBy(candidate, prior, { it.revision }, { it.start }, { it.title }, { it.eventId }) > 0

    private fun applyCacheData(
        window: CalendarCacheWindow,
        snapshot: CalendarCacheSnapshot?,
        preferences: CalendarCachePreferences?,
        hasSeenPreferences: Boolean,
        hasSeenSnapshot: Boolean,
        snapshotChanged: Boolean,
    ) {
        if (closed) return
        val current = _state.value
        val occurrences = if (hasSeenSnapshot) snapshot?.occurrences.orEmpty() else current.authorizedOccurrences
        val hasCache = if (hasSeenSnapshot) snapshot != null else current.hasCompleteCache && current.cachedWindow == window
        val nextPresentation = preferences?.let(::presentationFor)
        val base = nextPresentation ?: current
        val snapshotIsOffline = snapshot?.freshness == CalendarFreshness.CACHED_OFFLINE || snapshot?.freshness?.isUnavailableOffline == true
        val projection = buildProjection(base, occurrences)
        val next = current.copy(
            anchorDate = base.anchorDate,
            view = base.view,
            selectedDate = base.selectedDate,
            filters = base.filters,
            locale = base.locale,
            todayDate = base.todayDate,
            visibleInterval = window.toDateInterval(),
            selectedInterval = selectedDateInterval(base.selectedDate),
            authorizedOccurrences = occurrences,
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            hasCompleteCache = hasCache,
            cachedWindow = if (hasCache) snapshot?.window ?: current.cachedWindow else null,
            persistedCachePreferences = if (hasSeenPreferences) preferences else current.persistedCachePreferences,
            loading = if (snapshot != null && current.loading.phase == CalendarLoadingPhase.LOADING) CalendarLoadingState() else current.loading,
            freshness = if (snapshotChanged && snapshot != null) snapshot.freshness else current.freshness,
            error = if (snapshotChanged && snapshot?.freshness == CalendarFreshness.FRESH) null else current.error,
            offline = if (snapshotChanged && snapshot != null) {
                if (snapshotIsOffline) CalendarOfflineState.OFFLINE else CalendarOfflineState.ONLINE
            } else {
                current.offline
            },
            mutationAvailability = if (snapshot != null && snapshotChanged && current.error == null) {
                if (snapshotIsOffline) {
                    unavailableMutationAvailability(CalendarMutationAvailabilityReason.OFFLINE)
                } else {
                    CalendarMutationAvailability()
                }
            } else {
                current.mutationAvailability
            },
        )
        _state.value = next
    }

    private suspend fun recordViewedWindow(
        snapshot: CalendarCacheSnapshot,
        generation: Long,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ) {
        if (!isCurrent(generation, namespace, namespaceEpoch)) return
        val accessedAt = maxOf(nowMillis().coerceAtLeast(0L), snapshot.lastAccessedAt)
        if (accessedAt <= snapshot.lastAccessedAt) return
        val key = CalendarWindowRequestKey(namespace, snapshot.window)
        val registrationGeneration = bookkeepingGeneration
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                cacheStore.touchAndRetainForNamespace(
                    namespace = namespace,
                    window = snapshot.window,
                    lastAccessedAt = accessedAt,
                    maxWindows = io.sentient.mobiledata.cache.CALENDAR_CACHE_MAX_RETAINED_WINDOWS,
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Metadata failure never removes already decoded visible data.
            }
        }
        val registered = bookkeepingMutex.withLock {
            val existing = accessWriteJobs[key]?.takeIf { !it.job.isCompleted }
            if (existing != null) {
                false
            } else {
                accessWriteJobs[key] = BookkeepingJobRegistration(registrationGeneration, job)
                true
            }
        }
        if (!registered) {
            job.cancel()
            return
        }
        if (registrationGeneration != bookkeepingGeneration) {
            bookkeepingMutex.withLock {
                if (accessWriteJobs[key]?.job === job) accessWriteJobs.remove(key)
            }
            job.cancel()
            return
        }
        job.invokeOnCompletion {
            scope.launch {
                bookkeepingMutex.withLock {
                    if (accessWriteJobs[key]?.job === job) accessWriteJobs.remove(key)
                }
            }
        }
        // Registration precedes start so even an immediately completed touch
        // cannot escape coalescing.
        job.start()
    }

    private suspend fun scheduleAdjacentPrefetch(
        window: CalendarCacheWindow,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ): List<Job> {
        if (closed || accessDisabled || !isNamespaceCurrent(namespace, namespaceEpoch)) return emptyList()
        val scheduled = mutableListOf<Job>()
        val registrationGeneration = bookkeepingGeneration
        bookkeepingMutex.withLock {
            adjacentMonthWindows(window).forEach { target ->
                // The visible window is already owned by the foreground
                // revalidation path; scheduling it again after a fast
                // completion would defeat coalescing. Previous/next are the
                // actual adjacent prefetches.
                if (target == window) return@forEach
                val key = CalendarWindowRequestKey(namespace, target)
                if (key in scheduledPrefetchKeys || prefetchJobs[key]?.let { !it.job.isCompleted } == true) return@forEach
                scheduledPrefetchKeys[key] = registrationGeneration
                val job = scope.launch(start = CoroutineStart.LAZY) {
                    when (val result = loadWindow(target, namespace, namespaceEpoch)) {
                        WindowLoadResult.Cancelled -> Unit
                        is WindowLoadResult.Complete -> clearPrefetchDiagnostic(key)
                        is WindowLoadResult.Failed -> when (result.error.kind) {
                            CalendarExperienceErrorKind.AUTHORIZATION -> scheduleAuthenticationExpiry(namespace, namespaceEpoch)
                            CalendarExperienceErrorKind.FORBIDDEN -> scheduleForbiddenPurge(namespace, result.error)
                            else -> recordPrefetchFailure(key, target, result.error)
                        }
                    }
                }
                // Put the job in the map before starting it. Fast completion
                // therefore cannot create a second adjacent request.
                prefetchJobs[key] = BookkeepingJobRegistration(registrationGeneration, job)
                job.invokeOnCompletion {
                    scope.launch {
                        bookkeepingMutex.withLock {
                            if (prefetchJobs[key]?.job === job) prefetchJobs.remove(key)
                        }
                    }
                }
                scheduled += job
            }
        }
        if (registrationGeneration != bookkeepingGeneration) {
            bookkeepingMutex.withLock {
                val obsolete = prefetchJobs.filterValues {
                    it.bookkeepingGeneration == registrationGeneration && it.job in scheduled
                }.keys.toList()
                obsolete.forEach { prefetchJobs.remove(it) }
                scheduledPrefetchKeys
                    .filterValues { it == registrationGeneration }
                    .keys
                    .filter { it !in prefetchJobs }
                    .forEach { scheduledPrefetchKeys.remove(it) }
            }
            scheduled.forEach { it.cancel() }
            return emptyList()
        }
        scheduled.forEach { it.start() }
        return scheduled
    }

    private fun recordPrefetchFailure(
        key: CalendarWindowRequestKey,
        window: CalendarCacheWindow,
        error: CalendarExperienceError,
    ) {
        if (closed || !isNamespaceCurrent(key.namespace, namespaceGeneration)) return
        val kind = when (error.kind) {
            CalendarExperienceErrorKind.CONNECTION,
            CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE,
            -> CalendarPrefetchFailureKind.CONNECTION
            CalendarExperienceErrorKind.AUTHORIZATION -> CalendarPrefetchFailureKind.AUTHORIZATION
            CalendarExperienceErrorKind.FORBIDDEN -> CalendarPrefetchFailureKind.FORBIDDEN
            CalendarExperienceErrorKind.MALFORMED -> CalendarPrefetchFailureKind.MALFORMED
            CalendarExperienceErrorKind.DECODE -> CalendarPrefetchFailureKind.DECODE
            CalendarExperienceErrorKind.CONTRACT -> CalendarPrefetchFailureKind.CONTRACT
            CalendarExperienceErrorKind.CACHE,
            CalendarExperienceErrorKind.DATABASE,
            -> CalendarPrefetchFailureKind.DATABASE
            CalendarExperienceErrorKind.UNKNOWN -> CalendarPrefetchFailureKind.UNKNOWN
        }
        val diagnostic = CalendarPrefetchDiagnostic(window, kind, nowMillis().coerceAtLeast(0L))
        _prefetchDiagnostics.update { diagnostics ->
            diagnostics.filterNot { it.window == window }
                .takeLast(MAX_PREFETCH_DIAGNOSTICS - 1) + diagnostic
        }
    }

    private fun clearPrefetchDiagnostic(key: CalendarWindowRequestKey) {
        _prefetchDiagnostics.update { diagnostics ->
            diagnostics.filterNot { it.window == key.window }
        }
    }

    private fun preparePrefetchForRecovery() {
        val namespace = cacheStore.currentNamespace.value
        if (bookkeepingMutex.tryLock()) {
            try {
                _prefetchDiagnostics.value.forEach { diagnostic ->
                    scheduledPrefetchKeys.remove(CalendarWindowRequestKey(namespace, diagnostic.window))
                }
            } finally {
                bookkeepingMutex.unlock()
            }
        } else {
            scope.launch {
                bookkeepingMutex.withLock {
                    _prefetchDiagnostics.value.forEach { diagnostic ->
                        scheduledPrefetchKeys.remove(CalendarWindowRequestKey(namespace, diagnostic.window))
                    }
                }
            }
        }
    }

    private fun cancelAccessWriteJobs() {
        val cancellationGeneration = ++bookkeepingGeneration
        if (bookkeepingMutex.tryLock()) {
            val jobs = try {
                val keys = accessWriteJobs.filterValues {
                    it.bookkeepingGeneration < cancellationGeneration
                }.keys.toList()
                val selected = keys.mapNotNull { accessWriteJobs[it]?.job }
                keys.forEach { accessWriteJobs.remove(it) }
                selected
            } finally {
                bookkeepingMutex.unlock()
            }
            jobs.forEach { it.cancel() }
        } else {
            scope.launch {
                val jobs = bookkeepingMutex.withLock {
                    val keys = accessWriteJobs.filterValues {
                        it.bookkeepingGeneration < cancellationGeneration
                    }.keys.toList()
                    val selected = keys.mapNotNull { accessWriteJobs[it]?.job }
                    keys.forEach { accessWriteJobs.remove(it) }
                    selected
                }
                jobs.forEach { it.cancel() }
            }
        }
    }

    private fun cancelPrefetchWork() {
        val cancellationGeneration = ++bookkeepingGeneration
        if (bookkeepingMutex.tryLock()) {
            val jobs = try {
                val keys = prefetchJobs.filterValues {
                    it.bookkeepingGeneration < cancellationGeneration
                }.keys.toList()
                val selected = keys.mapNotNull { prefetchJobs[it]?.job }
                keys.forEach { prefetchJobs.remove(it) }
                scheduledPrefetchKeys
                    .filterValues { it < cancellationGeneration }
                    .keys
                    .toList()
                    .forEach { scheduledPrefetchKeys.remove(it) }
                selected
            } finally {
                bookkeepingMutex.unlock()
            }
            jobs.forEach { it.cancel() }
        } else {
            scope.launch {
                val jobs = bookkeepingMutex.withLock {
                    val keys = prefetchJobs.filterValues {
                        it.bookkeepingGeneration < cancellationGeneration
                    }.keys.toList()
                    val selected = keys.mapNotNull { prefetchJobs[it]?.job }
                    keys.forEach { prefetchJobs.remove(it) }
                    scheduledPrefetchKeys
                        .filterValues { it < cancellationGeneration }
                        .keys
                        .toList()
                        .forEach { scheduledPrefetchKeys.remove(it) }
                    selected
                }
                jobs.forEach { it.cancel() }
            }
        }
        _prefetchDiagnostics.value = emptyList()
    }

    /**
     * Atomically advances the request generation, removes the exact old
     * entries, then cancels the detached Deferreds. This cannot use a
     * suspending Mutex: [observe] and namespace invalidation must complete the
     * registry transition synchronously before a same-key lookup can run.
     */
    private fun cancelSharedRequests() {
        ++bookkeepingGeneration
        val requests: List<Deferred<WindowLoadResult>>
        while (true) {
            val registry = inFlightRequests.load()
            val cancellationGeneration = registry.generation + 1L
            val selected = registry.entries.values
                .filter { it.bookkeepingGeneration < cancellationGeneration }
                .map { it.deferred }
            val next = InFlightRequestRegistry(
                generation = cancellationGeneration,
                entries = registry.entries.filterValues {
                    it.bookkeepingGeneration >= cancellationGeneration
                },
            )
            if (inFlightRequests.compareAndSet(registry, next)) {
                requests = selected
                break
            }
        }
        // Cancellation is deliberately outside the atomic registry update:
        // no lookup can observe the removed entries, and a completion callback
        // can only remove an entry whose Deferred identity still matches.
        requests.forEach { it.cancel() }
    }

    private fun adjacentMonthWindows(window: CalendarCacheWindow): List<CalendarCacheWindow> {
        val start = parseCalendarDate(window.windowStart)
        val currentMonth = formatCalendarDate(DateParts(start.year, start.month, 1))
        val isMonthBoundaryWindow = window.windowStart == currentMonth &&
            window.windowEnd == addCalendarMonthsClamped(currentMonth, 1)
        if (isMonthBoundaryWindow) {
            return (-1..1).map { offset ->
                val monthStart = addCalendarMonthsClamped(currentMonth, offset)
                CalendarCacheWindow(
                    windowStart = monthStart,
                    windowEnd = addCalendarMonthsClamped(monthStart, 1),
                    timezoneInput = window.timezoneInput,
                )
            }
        }

        // Projection windows for a normal Month view are locale-aware six-row
        // grids rather than first-of-month boundaries. Reusing that shape keeps
        // an adjacent prefetch usable when navigation later requests the grid
        // for the neighboring anchor.
        val anchor = _state.value.anchorDate.takeIf(CalendarDates::isValid) ?: currentMonth
        val locale = _state.value.locale
        return (-1..1).map { offset ->
            val anchorForMonth = addCalendarMonthsClamped(anchor, offset)
            val interval = calendarVisibleInterval(CalendarView.MONTH, anchorForMonth, locale)
            CalendarCacheWindow(
                windowStart = interval.startDate,
                windowEnd = interval.endExclusive,
                timezoneInput = window.timezoneInput,
            )
        }
    }

    private fun applyCommittedData(
        window: CalendarCacheWindow,
        occurrences: List<EffectiveOccurrence>,
        fetchedAt: Long,
    ) {
        val current = _state.value
        val projection = buildProjection(current, occurrences)
        _state.value = current.copy(
            visibleInterval = window.toDateInterval(),
            authorizedOccurrences = occurrences,
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            freshness = CalendarFreshness.FRESH,
            loading = CalendarLoadingState(),
            offline = CalendarOfflineState.ONLINE,
            error = null,
            hasCompleteCache = true,
            cachedWindow = window,
            mutationAvailability = CalendarMutationAvailability(),
        )
        // The generation marker is deliberately represented by the persisted
        // cache snapshot, not by a second in-memory page cache.
        @Suppress("UNUSED_VARIABLE")
        val committedAt = fetchedAt
    }

    private fun applyPresentation(next: CalendarExperienceState) {
        val current = _state.value
        val projection = buildProjection(next, current.authorizedOccurrences)
        _state.value = current.copy(
            anchorDate = next.anchorDate,
            view = next.view,
            selectedDate = next.selectedDate,
            filters = next.filters,
            locale = next.locale,
            todayDate = next.todayDate,
            visibleInterval = calendarVisibleInterval(next.view, next.anchorDate, next.locale),
            selectedInterval = selectedDateInterval(next.selectedDate),
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            // A local filter/view intent is immediately usable over cached data.
            error = current.error,
        )
    }

    private fun persistPresentation(presentation: CalendarExperienceState) {
        val cachePreferences = presentation.toCachePreferences(nowMillis().coerceAtLeast(0L))
        val generation = ++preferenceWriteGeneration
        val namespace = cacheStore.currentNamespace.value
        val namespaceEpoch = namespaceGeneration
        preferenceWriteJob?.cancel()
        val writeJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val result = try {
                cacheStore.writePreferencesForNamespace(namespace, cachePreferences)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (cancelled: KotlinCancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                CalendarCacheResult.Failure(
                    io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
                )
            }
            if (closed || generation != preferenceWriteGeneration || !isNamespaceCurrent(namespace, namespaceEpoch)) return@launch
            if (result is CalendarCacheResult.Failure) updateError(cacheFailure(result.error.reason))
            else _state.value = _state.value.copy(persistedCachePreferences = cachePreferences)
        }
        preferenceWriteJob = writeJob
        writeJob.invokeOnCompletion {
            if (preferenceWriteJob === writeJob) preferenceWriteJob = null
        }
    }

    private fun markObservationStarted(window: CalendarCacheWindow) {
        val current = _state.value
        val sameCachedWindow = current.hasCompleteCache && current.cachedWindow == window
        val base = if (!sameCachedWindow && current.hasCompleteCache) {
            // A different visible interval must not render the previous window's
            // events as if they belonged to the new one. Same-window refreshes
            // take the stale-while-revalidate path below and retain content.
            val emptyProjection = buildProjection(current, emptyList())
            current.copy(
                authorizedOccurrences = emptyList(),
                projection = emptyProjection,
                facets = emptyProjection?.facets ?: emptyCalendarFacets(),
                hasCompleteCache = false,
                cachedWindow = null,
            )
        } else {
            current
        }
        _state.value = base.copy(
            visibleInterval = window.toDateInterval(),
            loading = CalendarLoadingState(
                if (sameCachedWindow) CalendarLoadingPhase.REFRESHING else CalendarLoadingPhase.LOADING,
            ),
            freshness = if (sameCachedWindow) CalendarFreshness.REFRESHING else CalendarFreshness.STALE,
            error = null,
            offline = CalendarOfflineState.ONLINE,
        )
    }

    /** Clear all predecessor-derived state before the successor namespace is
     * allowed to start a cache read. */
    private fun invalidateForNamespace(
        namespace: CalendarCacheNamespace,
        updateObservedNamespace: Boolean = true,
        cancelAuthExpiry: Boolean = true,
    ) {
        if (closed) return
        if (namespace != observedNamespace) accessDisabled = false
        if (updateObservedNamespace) observedNamespace = namespace
        namespaceGeneration += 1L
        requestGeneration += 1L
        mutationGeneration += 1L
        observationJob?.cancel()
        refreshJob?.cancel()
        mutationJob?.cancel()
        mutationRefreshJob?.cancel()
        preferenceWriteGeneration += 1L
        preferenceWriteJob?.cancel()
        if (cancelAuthExpiry) authExpiryJob?.cancel()
        cancelAccessWriteJobs()
        cancelPrefetchWork()
        cancelSharedRequests()
        observationJob = null
        refreshJob = null
        mutationJob = null
        mutationRefreshJob = null
        preferenceWriteJob = null
        revalidationGeneration = null
        activeWindow = requestedWindow
        _state.value = initialState.copy(
            visibleInterval = requestedWindow.toDateInterval(),
            selectedInterval = selectedDateInterval(initialState.selectedDate),
            freshness = CalendarFreshness.STALE,
            loading = CalendarLoadingState(),
            offline = CalendarOfflineState.UNAVAILABLE,
            error = null,
            hasCompleteCache = false,
            cachedWindow = null,
            authorizedOccurrences = emptyList(),
            projection = null,
            facets = emptyCalendarFacets(),
            persistedCachePreferences = null,
            mutationAvailability = unavailableMutationAvailability(CalendarMutationAvailabilityReason.UNAVAILABLE),
            mutation = CalendarMutationState(),
        )
    }

    private fun handleNamespaceChange(namespace: CalendarCacheNamespace) {
        if (closed || namespace == observedNamespace) return
        invalidateForNamespace(namespace)
        // The store publishes the namespace before this callback runs. Starting
        // here therefore observes only the new selected SQLDelight namespace.
        if (!closed && cacheStore.currentNamespace.value == namespace) observe(requestedWindow)
    }

    private fun updateError(error: CalendarExperienceError) {
        if (closed) return
        _state.value = _state.value.copy(error = error)
    }

    private suspend fun readPreferencesSafely(
        expectedNamespace: CalendarCacheNamespace,
    ): CalendarCacheResult<CalendarCachePreferences?> = try {
        val result = cacheStore.readPreferences()
        if (cacheStore.currentNamespace.value != expectedNamespace) {
            CalendarCacheResult.Failure(
                io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.INVALID_NAMESPACE),
            )
        } else {
            result
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (cancelled: KotlinCancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        CalendarCacheResult.Failure(
            io.sentient.mobiledata.cache.CalendarCacheFailure(CalendarCacheFailureReason.DATABASE),
        )
    }

    private fun buildProjection(
        presentation: CalendarExperienceState,
        occurrences: List<EffectiveOccurrence>,
    ): CalendarExperienceProjection? = try {
        projectCalendar(
            occurrences = occurrences,
            anchorDate = presentation.anchorDate,
            view = presentation.view,
            selectedDate = presentation.selectedDate,
            todayDate = presentation.todayDate,
            locale = presentation.locale,
            filters = presentation.filters,
        )
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun presentationFor(preferences: CalendarCachePreferences): CalendarExperienceState {
        val current = _state.value
        val pure = preferences.toCalendarPreferences().copy(
            selectedDate = preferences.anchorDate,
            locale = current.locale,
        )
        return current.copy(
            anchorDate = pure.anchorDate,
            view = pure.view,
            selectedDate = pure.selectedDate,
            filters = pure.filters,
            locale = pure.locale,
            todayDate = current.todayDate,
        )
    }

    private fun applyRestoredPreferences(preferences: CalendarCachePreferences, window: CalendarCacheWindow) {
        val current = _state.value
        val next = presentationFor(preferences)
        val projection = buildProjection(next, current.authorizedOccurrences)
        _state.value = current.copy(
            anchorDate = next.anchorDate,
            view = next.view,
            selectedDate = next.selectedDate,
            filters = next.filters,
            visibleInterval = window.toDateInterval(),
            selectedInterval = selectedDateInterval(next.selectedDate),
            projection = projection,
            facets = projection?.facets ?: emptyCalendarFacets(),
            persistedCachePreferences = preferences,
        )
    }

    private fun validatePreferences(value: CalendarCachePreferences): CalendarCachePreferences? = try {
        require(CalendarDates.isValid(value.anchorDate))
        require(value.updatedAt >= 0L)
        require(value.scopes.isNotEmpty())
        require(value.groups.size <= MAX_FILTER_VALUES && value.tags.size <= MAX_FILTER_VALUES)
        require(value.groups.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(value.tags.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(value.searchText.length <= MAX_SEARCH_LENGTH)
        val scopes = value.scopes.distinct().let { values ->
            if (CalendarScope.ALL in values) listOf(CalendarScope.ALL) else values.sortedBy { it.ordinal }
        }
        value.copy(
            scopes = scopes,
            groups = value.groups.distinct().sorted(),
            tags = value.tags.distinct().sorted(),
        )
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun validateFilters(filters: CalendarFilters): CalendarFilters {
        require(filters.text.length <= MAX_SEARCH_LENGTH)
        require(filters.groups.size <= MAX_FILTER_VALUES && filters.tags.size <= MAX_FILTER_VALUES)
        require(filters.groups.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        require(filters.tags.all { it.isNotBlank() && it.length <= MAX_FILTER_VALUE_LENGTH })
        return filters.copy(
            groups = filters.groups.map(String::trim).distinct().sorted().toSet(),
            tags = filters.tags.map(String::trim).distinct().sorted().toSet(),
            text = filters.text,
        )
    }

    private fun CalendarExperienceState.toCachePreferences(updatedAt: Long): CalendarCachePreferences = CalendarCachePreferences(
        view = view,
        anchorDate = anchorDate,
        scopes = listOf(filters.scope),
        groups = filters.groups.toList(),
        tags = filters.tags.toList(),
        importance = filters.importance,
        searchText = filters.text,
        updatedAt = updatedAt,
    )

    private fun repositoryError(error: SentientError): CalendarExperienceError {
        val message = error.userMessage.lowercase()
        return when (error) {
            is SentientError.Connection,
            is SentientError.Timeout,
            -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.CONNECTION,
                userMessage = "Network unavailable. Cached calendar data is still shown.",
            )
            is SentientError.Auth -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.AUTHORIZATION,
                userMessage = "Your session expired. Please sign in again.",
                recoverable = false,
            )
            is SentientError.Protocol -> when {
                "forbidden" in message || "permission" in message -> CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.FORBIDDEN,
                    userMessage = "You do not have permission to read this calendar.",
                )
                "malformed" in message || "decode" in message || "invalid response" in message -> CalendarExperienceError(
                    kind = CalendarExperienceErrorKind.MALFORMED,
                    userMessage = "The calendar returned an invalid response.",
                )
                else -> contractError("The calendar request could not be completed.")
            }
            is SentientError.Cycle -> contractError("Calendar pagination could not be completed.")
            is SentientError.Unknown -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.UNKNOWN,
                userMessage = "The calendar could not be loaded.",
            )
            is SentientError.Outbox -> CalendarExperienceError(
                kind = CalendarExperienceErrorKind.UNKNOWN,
                userMessage = "The calendar could not be loaded.",
            )
        }
    }

    private suspend fun persistFreshness(
        namespace: CalendarCacheNamespace,
        window: CalendarCacheWindow,
        namespaceEpoch: Long,
        freshness: CalendarFreshness,
    ) {
        if (!isNamespaceCurrent(namespace, namespaceEpoch)) return
        try {
            cacheStore.markFreshnessForNamespace(namespace, window, freshness)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cancelled: KotlinCancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The in-memory state remains authoritative for this observation;
            // a metadata-only persistence failure must not hide cached events.
        }
    }

    private fun cacheFailure(reason: CalendarCacheFailureReason): CalendarExperienceError = when (reason) {
        CalendarCacheFailureReason.DECODE,
        CalendarCacheFailureReason.INVALID_PREFERENCES,
        CalendarCacheFailureReason.INVALID_SNAPSHOT,
        -> CalendarExperienceError(
            kind = CalendarExperienceErrorKind.DECODE,
            userMessage = "Saved calendar data could not be decoded.",
        )
        CalendarCacheFailureReason.INVALID_WINDOW,
        CalendarCacheFailureReason.INVALID_NAMESPACE,
        -> contractError("The calendar cache key is invalid.")
        CalendarCacheFailureReason.CLOSED,
        CalendarCacheFailureReason.DATABASE,
        CalendarCacheFailureReason.INVALID_RETENTION,
        CalendarCacheFailureReason.NOT_FOUND,
        -> CalendarExperienceError(
            kind = CalendarExperienceErrorKind.DATABASE,
            userMessage = "Calendar cache is unavailable.",
        )
    }

    private fun unavailableOfflineError() = CalendarExperienceError(
        kind = CalendarExperienceErrorKind.UNAVAILABLE_OFFLINE,
        userMessage = "This calendar interval is unavailable offline. Connect to load it.",
    )

    private fun contractError(message: String) = CalendarExperienceError(
        kind = CalendarExperienceErrorKind.CONTRACT,
        userMessage = message,
    )

    private fun unavailableMutationAvailability(reason: CalendarMutationAvailabilityReason) = CalendarMutationAvailability(
        canCreate = false,
        canEdit = false,
        canDelete = false,
        reason = reason,
    )

    private fun isRequestCurrent(
        generation: Long?,
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ): Boolean = if (generation == null) {
        isNamespaceCurrent(namespace, namespaceEpoch)
    } else {
        isCurrent(generation, namespace, namespaceEpoch)
    }

    private fun isCurrent(
        generation: Long,
        namespace: CalendarCacheNamespace = observedNamespace,
        namespaceEpoch: Long = this.namespaceGeneration,
    ): Boolean = !closed &&
        generation == requestGeneration &&
        this.namespaceGeneration == namespaceEpoch &&
        activeWindow == requestedWindow &&
        cacheStore.currentNamespace.value == namespace

    private fun isNamespaceCurrent(
        namespace: CalendarCacheNamespace,
        namespaceEpoch: Long,
    ): Boolean = !closed && this.namespaceGeneration == namespaceEpoch && cacheStore.currentNamespace.value == namespace

    private fun windowFor(presentation: CalendarExperienceState, timezoneInput: String? = null): CalendarCacheWindow {
        val interval = calendarVisibleInterval(presentation.view, presentation.anchorDate, presentation.locale)
        val timezone = timezoneInput?.takeIf(String::isNotBlank)
            ?: presentation.locale.timeZoneId.takeIf(String::isNotBlank)
            ?: io.sentient.mobilesdk.calendar.CALENDAR_WIRE_TIME_ZONE
        return CalendarCacheWindow(interval.startDate, interval.endExclusive, timezone)
    }

    private fun selectedDateInterval(date: String): CalendarDateInterval = CalendarDateInterval(
        startDate = date,
        endExclusive = CalendarDates.addDays(date, 1),
    )

    private fun CalendarCacheWindow.toDateInterval(): CalendarDateInterval = CalendarDateInterval(windowStart, windowEnd)

    private class MalformedCalendarPageException : Exception()
    private class ContractViolationException : Exception()

    private companion object {
        const val MAX_PAGES = 10_000
        const val MAX_PREFETCH_DIAGNOSTICS = 16
        const val MAX_FILTER_VALUE_LENGTH = 256
        const val MAX_FILTER_VALUES = 128
        const val MAX_SEARCH_LENGTH = 512
    }
}

/** A factory seam for authenticated session construction before platform drivers are wired. */
fun interface CalendarExperienceFactory {
    fun create(repository: CalendarRepository): CalendarExperience
}

class DefaultCalendarExperienceFactory(
    private val cacheStore: CalendarCacheStore,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val initialWindow: CalendarCacheWindow? = null,
    private val initialLocale: CalendarLocale = CalendarLocale(),
) : CalendarExperienceFactory {
    override fun create(repository: CalendarRepository): CalendarExperience = CalendarExperience(
        repository = repository,
        cacheStore = cacheStore,
        scope = scope,
        initialWindow = initialWindow,
        initialLocale = initialLocale,
    )
}

fun createCalendarExperience(
    repository: CalendarRepository,
    cacheStore: CalendarCacheStore,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    initialWindow: CalendarCacheWindow? = null,
    initialAnchorDate: String? = null,
    initialLocale: CalendarLocale = CalendarLocale(),
    nowMillis: () -> Long = { KtClock.System.now().toEpochMilliseconds() },
    todayDate: () -> String = ::defaultCalendarToday,
): CalendarExperience = CalendarExperience(
    repository = repository,
    cacheStore = cacheStore,
    scope = scope,
    initialWindow = initialWindow,
    initialAnchorDate = initialAnchorDate,
    initialLocale = initialLocale,
    nowMillis = nowMillis,
    todayDate = todayDate,
)

private fun defaultCalendarToday(): String = KtClock.System.now()
    .toLocalDateTime(TimeZone.UTC)
    .date
    .toString()

private fun validOrFallbackDate(value: String?, fallback: String?): String {
    val candidate = value?.takeIf(CalendarDates::isValid)
    if (candidate != null) return candidate
    val safeFallback = fallback?.takeIf(CalendarDates::isValid)
    return safeFallback ?: "1970-01-01"
}
