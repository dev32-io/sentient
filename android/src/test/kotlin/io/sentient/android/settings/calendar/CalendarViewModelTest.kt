package io.sentient.android.settings.calendar

import io.sentient.android.history.CALENDAR_DRAWER_TEST_TAG
import io.sentient.android.nav.Routes
import io.sentient.android.nav.navigateToCalendar
import io.sentient.mobiledata.cache.CalendarCacheFreshness
import io.sentient.mobiledata.calendar.CalendarExperienceError
import io.sentient.mobiledata.calendar.CalendarExperienceErrorKind
import io.sentient.mobiledata.calendar.CalendarExperienceIntent
import io.sentient.mobiledata.calendar.CalendarConflictReviewState
import io.sentient.mobiledata.calendar.CalendarDeleteConfirmationState
import io.sentient.mobiledata.calendar.CalendarExperienceState
import io.sentient.mobiledata.calendar.CalendarFilters
import io.sentient.mobiledata.calendar.CalendarLoadingPhase
import io.sentient.mobiledata.calendar.CalendarLoadingState
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationEditorMode
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobiledata.calendar.CalendarMutationErrorKind
import io.sentient.mobiledata.calendar.CalendarMutationOperation
import io.sentient.mobiledata.calendar.CalendarMutationOutcome
import io.sentient.mobiledata.calendar.CalendarMutationPhase
import io.sentient.mobiledata.calendar.CalendarMutationTarget
import io.sentient.mobiledata.calendar.CalendarMutationState
import io.sentient.mobiledata.calendar.CalendarNavigationAction
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobiledata.calendar.CalendarView
import io.sentient.mobiledata.calendar.projectCalendar
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarViewModelTest {
    private val occurrence = EffectiveOccurrence(
        eventId = "event-1",
        occurrenceId = "occurrence-1",
        originalStart = "2026-08-01T13:00:00-04:00",
        recurring = true,
        revision = 7,
        scope = CalendarScope.HOUSEHOLD,
        title = "Dinner",
        start = "2026-08-01T13:00:00-04:00",
        end = "2026-08-01T14:00:00-04:00",
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
        group = "Family",
        tags = listOf("meal"),
    )

    @BeforeTest
    fun setMain() = Dispatchers.setMain(StandardTestDispatcher())

    @AfterTest
    fun resetMain() = Dispatchers.resetMain()

    @Test
    fun cache_first_sequence_and_all_four_shared_projections_map_without_reprojection() = runTest {
        val shared = kotlinx.coroutines.flow.MutableStateFlow(state(CalendarView.MONTH).copy(
            freshness = CalendarCacheFreshness.STALE,
            hasCompleteCache = true,
        ))
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val vm = CalendarViewModel(shared, {}, {}, scope)
        advanceUntilIdle()

        assertSame(shared.value.projection?.month, vm.ui.value.month)
        assertEquals(CalendarCacheFreshness.STALE, vm.ui.value.freshness)
        assertEquals(CalendarContentState.CONTENT, vm.ui.value.contentState)

        for (view in CalendarView.entries) {
            val next = state(view).copy(freshness = CalendarCacheFreshness.FRESH)
            shared.value = next
            advanceUntilIdle()
            assertEquals(view, vm.ui.value.view)
            when (view) {
                CalendarView.DAY -> assertSame(next.projection?.day, vm.ui.value.day)
                CalendarView.WEEK -> assertSame(next.projection?.week, vm.ui.value.week)
                CalendarView.MONTH -> assertSame(next.projection?.month, vm.ui.value.month)
                CalendarView.YEAR -> assertSame(next.projection?.year, vm.ui.value.year)
            }
        }
        scope.cancel()
    }

    @Test
    fun selected_date_filters_facets_freshness_and_offline_states_are_lossless() = runTest {
        val filters = CalendarFilters(
            scope = CalendarScope.HOUSEHOLD,
            groups = setOf("Family"),
            tags = setOf("meal"),
            importance = Importance.NORMAL,
            text = "Dinner",
        )
        val projected = projectCalendar(
            occurrences = listOf(occurrence),
            anchorDate = "2026-08-01",
            view = CalendarView.WEEK,
            selectedDate = "2026-08-02",
            todayDate = "2026-08-01",
            filters = filters,
        )
        val shared = CalendarExperienceState(
            anchorDate = projected.anchorDate,
            selectedDate = projected.selectedDate,
            todayDate = projected.todayDate,
            view = projected.view,
            filters = filters,
            locale = projected.locale,
            projection = projected,
            facets = projected.facets,
            freshness = CalendarCacheFreshness.CACHED_OFFLINE,
            offline = CalendarOfflineState.OFFLINE,
            hasCompleteCache = true,
        )

        val ui = shared.toAndroidUiState()

        assertSame(filters, ui.filters)
        assertSame(projected.facets, ui.facets)
        assertEquals("2026-08-02", ui.selectedDate)
        assertEquals(CalendarCacheFreshness.CACHED_OFFLINE, ui.freshness)
        assertTrue(ui.isOffline)
        assertEquals(CalendarContentState.CONTENT, ui.contentState)
    }

    @Test
    fun month_to_day_and_week_selection_retention_follow_shared_state_exactly() {
        val month = state(CalendarView.MONTH)
        val day = state(CalendarView.DAY, selectedDate = "2026-08-09")
        val week = state(CalendarView.WEEK, selectedDate = "2026-08-10")

        assertEquals("2026-08-01", month.toAndroidUiState().selectedDate)
        assertEquals("2026-08-09", day.toAndroidUiState().selectedDate)
        assertEquals("2026-08-01", week.anchorDate)
        assertEquals("2026-08-10", week.toAndroidUiState().selectedDate)
    }

    @Test
    fun loading_empty_error_offline_permission_confirmation_conflict_and_editor_are_representable() {
        val loading = state(CalendarView.MONTH, occurrences = emptyList()).copy(
            projection = null,
            loading = CalendarLoadingState(CalendarLoadingPhase.LOADING),
        )
        assertEquals(CalendarContentState.LOADING, loading.toAndroidUiState().contentState)

        val error = loading.copy(
            loading = CalendarLoadingState(),
            error = CalendarExperienceError(CalendarExperienceErrorKind.CONNECTION, "Connect to load calendar"),
        )
        assertEquals(CalendarContentState.ERROR, error.toAndroidUiState().contentState)

        val unavailable = error.copy(
            freshness = CalendarCacheFreshness.UNAVAILABLE_OFFLINE,
            offline = CalendarOfflineState.UNAVAILABLE,
        )
        assertEquals(CalendarContentState.UNAVAILABLE_OFFLINE, unavailable.toAndroidUiState().contentState)

        val draft = CalendarMutationDraft.fromOccurrence(occurrence)
        val editor = CalendarMutationEditorState(
            mode = CalendarMutationEditorMode.EDIT,
            draft = draft,
            applicableScopes = CalendarMutationScope.entries,
        )
        val target = requireNotNull(CalendarMutationTarget.fromOccurrence(occurrence))
        val confirmation = CalendarDeleteConfirmationState(
            target = target,
            applicableScopes = CalendarMutationScope.entries,
            selectedScope = CalendarMutationScope.THIS_OCCURRENCE,
        )
        val conflict = CalendarConflictReviewState(
            operation = CalendarMutationOperation.UPDATE,
            target = target,
            draft = draft,
        )
        val permission = CalendarMutationError(
            kind = CalendarMutationErrorKind.FORBIDDEN,
            userMessage = "This calendar action is not permitted.",
        )
        val outcome = CalendarMutationOutcome.Failure(
            operation = CalendarMutationOperation.UPDATE,
            error = permission,
            draft = draft,
        )
        val editing = state(CalendarView.DAY).copy(
            mutation = CalendarMutationState(
                phase = CalendarMutationPhase.DELETE_CONFIRMATION,
                editor = editor,
                deleteConfirmation = confirmation,
                conflict = conflict,
                error = permission,
                outcome = outcome,
            ),
        ).toAndroidUiState()
        assertSame(editor, editing.editor)
        assertSame(confirmation, editing.deleteConfirmation)
        assertSame(conflict, editing.conflict)
        assertSame(permission, editing.permissionError)
        assertSame(outcome, editing.outcome)
        assertSame(occurrence, editing.authorizedOccurrences.single())
        assertEquals(CalendarMutationPhase.DELETE_CONFIRMATION, editing.mutationPhase)
    }

    @Test
    fun every_navigation_filter_preview_editor_and_mutation_intent_is_forwarded_typed() {
        val intents = mutableListOf<CalendarExperienceIntent>()
        val shared = kotlinx.coroutines.flow.MutableStateFlow(state(CalendarView.MONTH))
        val vm = CalendarViewModel(shared, intents::add, {})
        val filters = CalendarFilters(tags = setOf("meal"))
        val draft = CalendarMutationDraft.fromOccurrence(occurrence)

        vm.today()
        vm.previous()
        vm.next()
        vm.selectDate("2026-08-02")
        vm.selectMonth(2026, 9)
        vm.selectView(CalendarView.YEAR)
        vm.setFilters(filters)
        shared.value = shared.value.copy(filters = filters)
        vm.search("dinner")
        vm.setLocale(shared.value.locale)
        vm.refresh()
        vm.openPreview(occurrence)
        vm.add(draft)
        vm.edit(occurrence, "America/Toronto")
        vm.openEditor(occurrence, draft)
        vm.updateDraft(draft)
        vm.chooseRecurrenceScope(CalendarMutationScope.THIS_OCCURRENCE)
        vm.save(draft)
        vm.requestDelete()
        vm.confirmDelete(CalendarMutationScope.THIS_AND_FOLLOWING)
        vm.rereadConflict()
        vm.reviewConflict(draft)
        vm.close()
        vm.acknowledgeOutcome()

        assertEquals(CalendarNavigationAction.Today, (intents[0] as CalendarExperienceIntent.Navigate).action)
        assertEquals(CalendarNavigationAction.Previous, (intents[1] as CalendarExperienceIntent.Navigate).action)
        assertEquals(CalendarNavigationAction.Next, (intents[2] as CalendarExperienceIntent.Navigate).action)
        assertEquals(CalendarNavigationAction.SelectDate("2026-08-02"), (intents[3] as CalendarExperienceIntent.Navigate).action)
        assertEquals(CalendarNavigationAction.SelectMonth(2026, 9), (intents[4] as CalendarExperienceIntent.Navigate).action)
        assertEquals(CalendarNavigationAction.SelectView(CalendarView.YEAR), (intents[5] as CalendarExperienceIntent.Navigate).action)
        assertSame(filters, ((intents[6] as CalendarExperienceIntent.Navigate).action as CalendarNavigationAction.SetFilters).filters)
        assertEquals("dinner", (((intents[7] as CalendarExperienceIntent.Navigate).action as CalendarNavigationAction.SetFilters).filters.text))
        assertTrue(intents[9] === CalendarExperienceIntent.Refresh)
        assertSame(occurrence, (intents[10] as CalendarExperienceIntent.OpenPreview).occurrence)
        assertSame(draft, (intents[11] as CalendarExperienceIntent.CreateDraft).draft)
        assertSame(occurrence, (intents[12] as CalendarExperienceIntent.EditOccurrence).occurrence)
        assertSame(draft, (intents[13] as CalendarExperienceIntent.OpenEditor).draft)
        assertSame(draft, (intents[14] as CalendarExperienceIntent.UpdateDraft).draft)
        assertEquals(CalendarMutationScope.THIS_OCCURRENCE, (intents[15] as CalendarExperienceIntent.ChooseMutationScope).scope)
        assertSame(draft, (intents[16] as CalendarExperienceIntent.Submit).draft)
        assertTrue(intents[17] === CalendarExperienceIntent.RequestDelete)
        assertEquals(CalendarMutationScope.THIS_AND_FOLLOWING, (intents[18] as CalendarExperienceIntent.ConfirmDelete).scope)
        assertTrue(intents[19] === CalendarExperienceIntent.RereadConflict)
        assertSame(draft, (intents[20] as CalendarExperienceIntent.ReviewConflict).draft)
        assertTrue(intents[21] === CalendarExperienceIntent.Cancel)
        assertTrue(intents[22] === CalendarExperienceIntent.AcknowledgeOutcome)
    }

    @Test
    fun collection_cancels_with_owned_scope_and_route_recreation_leaves_shared_state_alive() = runTest {
        val shared = kotlinx.coroutines.flow.MutableStateFlow(state(CalendarView.MONTH))
        var actualStarts = 0
        var started = false
        val start = { if (!started) { started = true; actualStarts++ } }
        val firstScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val secondScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        CalendarViewModel(shared, {}, start, firstScope)
        CalendarViewModel(shared, {}, start, secondScope)
        advanceUntilIdle()

        assertEquals(1, actualStarts)
        assertEquals(2, shared.subscriptionCount.value)
        firstScope.cancel()
        advanceUntilIdle()
        assertEquals(1, shared.subscriptionCount.value)
        assertFalse(started.not())
        shared.value = state(CalendarView.YEAR)
        advanceUntilIdle()
        assertEquals(CalendarView.YEAR, shared.value.view)
        secondScope.cancel()
    }

    @Test
    fun picker_conversion_preserves_all_mutation_identity_and_timezone_metadata() {
        val draft = CalendarMutationDraft.fromOccurrence(occurrence, "America/Toronto")
        val allDay = draft.withAllDayPickerValues(LocalDate.parse("2026-08-03"), LocalDate.parse("2026-08-04"))
        val timed = draft.withTimedPickerValues(
            LocalDateTime.parse("2026-08-03T09:30:00"),
            LocalDateTime.parse("2026-08-03T10:30:00"),
            ZoneId.of("America/Toronto"),
        )

        for (converted in listOf(allDay, timed)) {
            assertEquals(draft.eventId, converted.eventId)
            assertEquals(draft.occurrenceId, converted.occurrenceId)
            assertEquals(draft.originalStart, converted.originalStart)
            assertEquals(draft.expectedRevision, converted.expectedRevision)
            assertEquals(draft.scope, converted.scope)
            assertEquals(draft.inputTimeZoneId, converted.inputTimeZoneId)
        }
        assertEquals("2026-08-03", allDay.start)
        assertTrue(timed.start.endsWith("-04:00"))
    }

    @Test
    fun drawer_calendar_entry_navigates_to_calendar_route_and_keeps_accessibility_contract() {
        var destination: String? = null
        navigateToCalendar { destination = it }
        assertEquals("calendar-open", CALENDAR_DRAWER_TEST_TAG)
        assertEquals(Routes.SETTINGS_CALENDAR, destination)
    }

    private fun state(
        view: CalendarView,
        selectedDate: String = "2026-08-01",
        occurrences: List<EffectiveOccurrence> = listOf(occurrence),
    ): CalendarExperienceState {
        val projection = projectCalendar(
            occurrences = occurrences,
            anchorDate = "2026-08-01",
            view = view,
            selectedDate = selectedDate,
            todayDate = "2026-08-01",
        )
        return CalendarExperienceState(
            anchorDate = projection.anchorDate,
            view = view,
            selectedDate = selectedDate,
            todayDate = projection.todayDate,
            locale = projection.locale,
            projection = projection,
            facets = projection.facets,
            authorizedOccurrences = occurrences,
        )
    }
}
