package io.sentient.android.settings.calendar

import io.sentient.android.history.CALENDAR_DRAWER_TEST_TAG
import io.sentient.android.nav.Routes
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.calendar.CreateCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.DeleteCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.ListCalendarUseCase
import io.sentient.mobiledata.usecase.calendar.UpdateCalendarUseCase
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CalendarViewModelTest {
    private val event = CalendarEvent(
        id = "event-1", scope = CalendarScope.HOUSEHOLD, title = "Dinner",
        start = CalendarTime.AllDay("2026-08-01"), visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL, createdAt = "now", updatedAt = "now",
    )

    @Test
    fun successful_list_replaces_events_and_clears_error() {
        val state = CalendarUiState(error = "old")
            .foldList(SentientResult.Success(CalendarEventPage(listOf(event), 0)))
        assertEquals(listOf(event), state.events)
        assertEquals(false, state.loading)
        assertEquals(null, state.error)
    }

    @Test
    fun failed_list_preserves_existing_events_for_retry() {
        val state = CalendarUiState(events = listOf(event))
            .foldList(SentientResult.Failure(SentientError.Unknown("Calendar unavailable")))
        assertEquals(listOf(event), state.events)
        assertEquals("Calendar unavailable", state.error)
        assertEquals(false, state.loading)
    }

    @Test
    fun refresh_folds_timed_and_all_day_results_from_two_kind_windows() = runTest {
        val timed = event.copy(
            id = "timed-1",
            title = "Timed dinner",
            start = CalendarTime.Timed("2026-08-01T23:00:00.000Z", "America/Toronto"),
        )
        val list = FakeCalendarOperations(
            listResult = SentientResult.Success(CalendarEventPage(listOf(timed, event), 0)),
        )
        val vm = withMain { CalendarViewModel(list, list, list, list) }
        advanceUntilIdle()

        assertEquals(listOf(timed, event), vm.ui.value.events)
        assertEquals(1, list.bothCalls)
        assertIs<CalendarTime.Timed>(list.timedFrom)
        assertIs<CalendarTime.AllDay>(list.allDayFrom)
        Dispatchers.resetMain()
    }

    @Test
    fun create_transitions_through_success_and_keeps_server_metadata_out_of_draft_contract() = runTest {
        val created = event.copy(id = "created", createdAt = "server", updatedAt = "server")
        val list = FakeCalendarOperations(
            listResult = SentientResult.Success(CalendarEventPage(emptyList(), 0)),
            createResult = SentientResult.Success(created),
        )
        val vm = withMain { CalendarViewModel(list, list, list, list) }
        advanceUntilIdle()
        vm.create("  Picnic ", "2026-08-02")
        advanceUntilIdle()

        assertEquals("Picnic", list.created?.title)
        assertEquals("", list.created?.createdAt)
        assertEquals("", list.created?.updatedAt)
        assertFalseSaving(vm)
        Dispatchers.resetMain()
    }

    @Test
    fun update_uses_base_id_and_keeps_timed_start_kind() = runTest {
        val recurring = event.copy(
            id = "occurrence-1",
            occurrenceId = "occurrence-1",
            baseEventId = "recurring-1",
            start = CalendarTime.Timed("2026-08-01T13:00:00.000Z", "America/Toronto"),
        )
        val list = FakeCalendarOperations(
            listResult = SentientResult.Success(CalendarEventPage(listOf(recurring), 0)),
            updateResult = SentientResult.Success(recurring),
        )
        val vm = withMain { CalendarViewModel(list, list, list, list) }
        advanceUntilIdle()
        vm.update(recurring, "Updated", "2026-08-02")
        advanceUntilIdle()

        assertEquals("recurring-1", list.updatedId)
        val updatedStart = assertIs<CalendarTime.Timed>(list.updated?.start)
        assertEquals("America/Toronto", updatedStart.timeZoneId)
        assertTrue(updatedStart.instant.isNotBlank())
        Dispatchers.resetMain()
    }

    @Test
    fun drawer_calendar_entry_keeps_navigation_and_accessibility_contract() {
        assertEquals("calendar-open", CALENDAR_DRAWER_TEST_TAG)
        assertEquals("settings/calendar", Routes.SETTINGS_CALENDAR)
    }

    @Test
    fun device_formatter_renders_timed_and_all_day_starts() {
        assertEquals("2026-08-01", formatCalendarStart(CalendarTime.AllDay("2026-08-01")))
        assertEquals(
            "2026-08-01 09:00",
            formatCalendarStart(
                CalendarTime.Timed("2026-08-01T13:00:00.000Z", "UTC"),
                ZoneId.of("America/New_York"),
            ),
        )
    }

    private suspend fun kotlinx.coroutines.test.TestScope.withMain(block: () -> CalendarViewModel): CalendarViewModel {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        return try {
            block()
        } catch (t: Throwable) {
            Dispatchers.resetMain()
            throw t
        }
    }

    private fun assertFalseSaving(vm: CalendarViewModel) {
        assertEquals(false, vm.ui.value.saving)
        assertNull(vm.ui.value.operationError)
    }

    private class FakeCalendarOperations(
        private val listResult: SentientResult<CalendarEventPage>,
        private val createResult: SentientResult<CalendarEvent> = SentientResult.Failure(SentientError.Unknown("unused")),
        private val updateResult: SentientResult<CalendarEvent> = SentientResult.Failure(SentientError.Unknown("unused")),
        private val deleteResult: SentientResult<Unit> = SentientResult.Success(Unit),
    ) : ListCalendarUseCase, CreateCalendarUseCase, UpdateCalendarUseCase, DeleteCalendarUseCase {
        private val state = MutableStateFlow<SentientResult<CalendarEventPage>>(SentientResult.Loading())
        override val listState: StateFlow<SentientResult<CalendarEventPage>> = state
        var bothCalls = 0
        var timedFrom: CalendarTime? = null
        var allDayFrom: CalendarTime? = null
        var created: CalendarEvent? = null
        var updatedId: String? = null
        var updated: CalendarEvent? = null

        override suspend fun list(
            from: CalendarTime,
            to: CalendarTime,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
        ) = listResult

        override suspend fun listBoth(
            timedFrom: CalendarTime.Timed,
            timedTo: CalendarTime.Timed,
            allDayFrom: CalendarTime.AllDay,
            allDayTo: CalendarTime.AllDay,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
        ): SentientResult<CalendarEventPage> {
            bothCalls++
            this.timedFrom = timedFrom
            this.allDayFrom = allDayFrom
            return listResult
        }

        override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> {
            created = event
            return createResult
        }

        override suspend fun update(id: String, event: CalendarEvent): SentientResult<CalendarEvent> {
            updatedId = id
            updated = event
            return updateResult
        }

        override suspend fun delete(id: String): SentientResult<Unit> = deleteResult
    }
}
