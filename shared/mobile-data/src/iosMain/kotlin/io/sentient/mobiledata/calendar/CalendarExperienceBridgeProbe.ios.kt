package io.sentient.mobiledata.calendar

import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.cache.CalendarCachePreferences
import io.sentient.mobiledata.cache.CalendarCacheWindow
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * Deterministic iOS ABI probe for the complete state graph. It performs no IO
 * and exists so Swift compilation/runtime tests catch a SKIE regression before
 * a native surface depends on a newly-added nested state type.
 */
fun calendarExperienceBridgeProbe(): Flow<CalendarExperienceState> = flow {
    CalendarView.entries.forEach { view -> emit(bridgeProbeState(view)) }
}

private fun bridgeProbeState(view: CalendarView): CalendarExperienceState {
    val occurrence = EffectiveOccurrence(
        eventId = "bridge-event",
        occurrenceId = "bridge-occurrence",
        originalStart = "2026-08-17T09:00:00-07:00",
        recurring = true,
        revision = 7,
        scope = CalendarScope.HOUSEHOLD,
        title = "Bridge event",
        description = "Bridge description",
        start = "2026-08-17T10:00:00-07:00",
        end = "2026-08-17T10:30:00-07:00",
        visibility = Visibility.EVERYONE,
        importance = Importance.IMPORTANT,
        group = "family",
        tags = listOf("school"),
        recurrence = null,
    )
    val locale = CalendarLocale(
        languageTag = "en-US",
        timeZoneId = "America/Los_Angeles",
    )
    val filters = CalendarFilters(
        scope = CalendarScope.ALL,
        groups = setOf("family"),
        tags = setOf("school"),
        importance = Importance.IMPORTANT,
        text = "bridge",
    )
    val projection = projectCalendar(
        occurrences = listOf(occurrence),
        anchorDate = "2026-08-01",
        view = view,
        selectedDate = "2026-08-17",
        todayDate = "2026-08-17",
        locale = locale,
        filters = filters,
    )
    val draft = CalendarMutationDraft.fromOccurrence(occurrence, locale.timeZoneId)
    val target = CalendarMutationTarget.fromOccurrence(occurrence)!!
    val mutationError = CalendarMutationError(
        kind = CalendarMutationErrorKind.CONFLICT,
        userMessage = "Calendar changed.",
    )
    val editor = CalendarMutationEditorState(
        mode = CalendarMutationEditorMode.EDIT,
        draft = draft,
        target = target,
        applicableScopes = CalendarMutationScope.entries,
        selectedScope = CalendarMutationScope.THIS_OCCURRENCE,
    )
    val conflict = CalendarConflictReviewState(
        operation = CalendarMutationOperation.UPDATE,
        target = target,
        draft = draft,
        rereadInFlight = false,
        authoritativeEvent = null,
        reviewed = false,
    )
    val outcome = CalendarMutationOutcome.Failure(
        operation = CalendarMutationOperation.UPDATE,
        error = mutationError,
        draft = draft,
        request = null,
    )
    val mutation = CalendarMutationState(
        phase = CalendarMutationPhase.CONFLICT,
        preview = occurrence,
        editor = editor,
        deleteConfirmation = CalendarDeleteConfirmationState(
            target = target,
            applicableScopes = CalendarMutationScope.entries,
            selectedScope = CalendarMutationScope.THIS_OCCURRENCE,
        ),
        pendingRequest = null,
        error = mutationError,
        conflict = conflict,
        outcome = outcome,
        successorEventId = "bridge-successor",
        affectedWindows = listOf(CalendarCacheWindow("2026-08-01", "2026-09-01", locale.timeZoneId)),
    )
    return CalendarExperienceState(
        anchorDate = "2026-08-01",
        view = view,
        selectedDate = "2026-08-17",
        filters = filters,
        locale = locale,
        todayDate = "2026-08-17",
        visibleInterval = projection.interval,
        selectedInterval = CalendarDateInterval("2026-08-17", "2026-08-18"),
        authorizedOccurrences = listOf(occurrence),
        projection = projection,
        facets = CalendarFacetOptions(
            scopes = listOf(CalendarScope.ALL, CalendarScope.HOUSEHOLD),
            groups = listOf("family"),
            tags = listOf("school"),
            importances = listOf(Importance.IMPORTANT),
        ),
        freshness = if (view == CalendarView.YEAR) CalendarCacheFreshness.CACHED_OFFLINE else CalendarCacheFreshness.FRESH,
        loading = CalendarLoadingState(if (view == CalendarView.WEEK) CalendarLoadingPhase.REFRESHING else CalendarLoadingPhase.IDLE),
        offline = if (view == CalendarView.YEAR) CalendarOfflineState.OFFLINE else CalendarOfflineState.ONLINE,
        error = CalendarExperienceError(CalendarExperienceErrorKind.CONNECTION, "Calendar unavailable.", true),
        hasCompleteCache = true,
        cachedWindow = CalendarCacheWindow("2026-08-01", "2026-09-01", locale.timeZoneId),
        persistedCachePreferences = CalendarCachePreferences(
            view = view,
            anchorDate = "2026-08-01",
            scopes = listOf(CalendarScope.ALL),
            groups = listOf("family"),
            tags = listOf("school"),
            importance = Importance.IMPORTANT,
            searchText = "bridge",
            updatedAt = 1L,
        ),
        mutationAvailability = CalendarMutationAvailability(true, true, true),
        mutation = mutation,
    )
}
