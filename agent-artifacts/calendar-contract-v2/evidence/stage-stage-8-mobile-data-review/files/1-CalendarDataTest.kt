package io.sentient.mobiledata.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.data.calendar.SdkCalendarRepository
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.calendar.CalendarUseCases
import io.sentient.mobiledata.usecase.calendar.MutateCalendarUseCase
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarOperation
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.result.SentientError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotSame

class CalendarDataTest {
    private val time = CalendarTime.AllDay("2026-08-01")
    private val event = CalendarEvent(
        "event-1",
        CalendarScope.HOUSEHOLD,
        "Dinner",
        start = time,
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
        createdAt = "now",
        updatedAt = "now",
        revision = 7,
    )

    @Test
    fun repository_forwards_raw_range_cursor_and_mutation_without_state() = kotlinx.coroutines.test.runTest {
        val client = RecordingCalendarClient(
            listResult = AuthResult.Success(CalendarEventPage(listOf(event), nextCursor = "cursor-2")),
            mutationResult = AuthResult.Success(
                CalendarMutationResult(
                    CalendarOperation.UPDATE,
                    CalendarMutationScope.ENTIRE_SERIES,
                    eventId = "event-1",
                    resultingRevision = 8,
                ),
            ),
        )
        val repository = SdkCalendarRepository(client)

        val page = assertIs<SentientResult.Success<CalendarEventPage>>(
            repository.list("2026-08-01", "2026-08-31", cursor = "cursor-1", limit = 25),
        ).data
        assertEquals("cursor-1", client.cursor)
        assertEquals("2026-08-01", client.from)
        assertEquals("2026-08-31", client.to)
        assertEquals("cursor-2", page.nextCursor)
        val mutation = assertIs<SentientResult.Success<CalendarMutationResult>>(
            repository.mutate("event-1", CalendarMutationCommand.delete(CalendarMutationScope.ENTIRE_SERIES)),
        ).data
        assertEquals(CalendarMutationScope.ENTIRE_SERIES, mutation.appliedTo)
        assertFalse(repository === SdkCalendarRepository(client))
    }

    @Test
    fun listBoth_uses_one_mixed_kind_v2_query_and_preserves_cursor() = kotlinx.coroutines.test.runTest {
        val page = CalendarEventPage(listOf(event), nextCursor = "next")
        val repository = RecordingRepository(SentientResult.Success(page))
        val useCases = CalendarUseCases(repository)

        val result = useCases.listBoth(
            timedFrom = CalendarTime.Timed("2026-08-01T00:00:00.000Z", "UTC"),
            timedTo = CalendarTime.Timed("2026-08-02T00:00:00.000Z", "UTC"),
            allDayFrom = CalendarTime.AllDay("2026-08-01"),
            allDayTo = CalendarTime.AllDay("2026-08-02"),
        )

        assertEquals(SentientResult.Success(page), result)
        assertEquals(1, repository.listCalls)
        assertEquals("2026-08-01", repository.from)
        assertEquals("2026-08-02", repository.to)
        assertEquals("next", useCases.listState.value.let { assertIs<SentientResult.Success<CalendarEventPage>>(it).data.nextCursor })
    }

    @Test
    fun update_and_delete_adapters_mutate_entire_series_and_carry_revision() = kotlinx.coroutines.test.runTest {
        val repository = RecordingRepository(
            pageResult = SentientResult.Success(CalendarEventPage(listOf(event))),
            mutationResult = SentientResult.Success(
                CalendarMutationResult(
                    CalendarOperation.UPDATE,
                    CalendarMutationScope.ENTIRE_SERIES,
                    eventId = "event-1",
                    resultingRevision = 8,
                ),
            ),
        )
        val useCases = CalendarUseCases(repository)

        val updated = assertIs<SentientResult.Success<CalendarEvent>>(useCases.update("event-1", event)).data
        assertEquals(8, updated.revision)
        assertEquals(CalendarMutationScope.ENTIRE_SERIES, repository.lastCommand?.applyTo)
        assertEquals(7, repository.lastCommand?.expectedRevision)

        assertEquals(SentientResult.Success(Unit), useCases.delete(event))
        assertEquals(CalendarOperation.DELETE, repository.lastCommand?.operation)
        assertEquals(CalendarMutationScope.ENTIRE_SERIES, repository.lastCommand?.applyTo)
        assertEquals(CalendarScope.HOUSEHOLD, repository.lastCommand?.scope)
        assertEquals(7, repository.lastCommand?.expectedRevision)

        val privateEvent = event.copy(scope = CalendarScope.PRIVATE, revision = 11)
        assertEquals(SentientResult.Success(Unit), useCases.delete(privateEvent))
        assertEquals(CalendarScope.PRIVATE, repository.lastCommand?.scope)
        assertEquals(11, repository.lastCommand?.expectedRevision)
    }

    @Test
    fun stale_delete_conflict_propagates_without_exposing_server_body() = kotlinx.coroutines.test.runTest {
        val body = "{\"version\":2,\"requestId\":\"r1\",\"error\":{\"code\":\"conflict\",\"message\":\"private title\"}}"
        val repository = SdkCalendarRepository(
            RecordingCalendarClient(
                mutationResult = AuthResult.Failure(AuthError.Server(409, body)),
            ),
        )
        val failure = assertIs<SentientResult.Failure>(
            CalendarUseCases(repository).delete(event),
        )
        assertEquals("This calendar event changed. Refresh and try again.", failure.error.userMessage)
        assertFalse(failure.error.userMessage.contains("private title"))
    }

    @Test
    fun mutation_failure_is_typed_and_does_not_expose_server_body() = kotlinx.coroutines.test.runTest {
        val body = "{\"version\":2,\"requestId\":\"r1\",\"error\":{\"code\":\"conflict\",\"message\":\"private title\"}}"
        val repository = SdkCalendarRepository(
            RecordingCalendarClient(
                mutationResult = AuthResult.Failure(AuthError.Server(409, body)),
            ),
        )
        val failure = assertIs<SentientResult.Failure>(
            repository.mutate("event-1", CalendarMutationCommand.delete(CalendarMutationScope.ENTIRE_SERIES)),
        )
        assertEquals("This calendar event changed. Refresh and try again.", failure.error.userMessage)
        assertFalse(failure.error.userMessage.contains("private title"))
    }

    @Test
    fun unauthorized_calendar_failure_is_auth_typed_and_ui_safe() = kotlinx.coroutines.test.runTest {
        val body = "{\"error\":\"token canary\"}"
        val repository = SdkCalendarRepository(
            RecordingCalendarClient(
                mutationResult = AuthResult.Failure(AuthError.Server(401, body)),
            ),
        )
        val failure = assertIs<SentientResult.Failure>(
            repository.mutate("event-1", CalendarMutationCommand.delete(CalendarMutationScope.ENTIRE_SERIES)),
        )
        assertIs<SentientError.Auth>(failure.error)
        assertEquals("Your session expired. Please sign in again.", failure.error.userMessage)
        assertFalse(failure.error.userMessage.contains("token canary"))
    }

    @Test
    fun settings_exports_typed_mutation_use_case() {
        val component = SettingsComponent(HttpClient(MockEngine { respondOk() }), "ws://localhost", { "token" })
        assertIs<MutateCalendarUseCase>(component.mutateCalendar)
        assertEquals(component.calendar, component.mutateCalendar)
    }

    private class RecordingCalendarClient(
        private val listResult: AuthResult<CalendarEventPage> = AuthResult.Failure(AuthError.Unknown("unused")),
        val mutationResult: AuthResult<CalendarMutationResult> = AuthResult.Failure(AuthError.Unknown("unused")),
    ) : CalendarHttpClient(HttpClient(MockEngine { respondOk() }), "ws://localhost", { "token" }) {
        var from: String? = null
        var to: String? = null
        var cursor: String? = null

        override suspend fun list(
            from: String,
            to: String,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
            cursor: String?,
            query: String?,
            limit: Int?,
        ): AuthResult<CalendarEventPage> {
            this.from = from
            this.to = to
            this.cursor = cursor
            return listResult
        }

        override suspend fun mutate(eventId: String, command: CalendarMutationCommand) = mutationResult
    }

    private class RecordingRepository(
        private val pageResult: SentientResult<CalendarEventPage>,
        private val mutationResult: SentientResult<CalendarMutationResult> = SentientResult.Success(
            CalendarMutationResult(
                CalendarOperation.UPDATE,
                CalendarMutationScope.ENTIRE_SERIES,
                eventId = "event-1",
                resultingRevision = 8,
            ),
        ),
    ) : CalendarRepository {
        var listCalls = 0
        var from: String? = null
        var to: String? = null
        var lastCommand: CalendarMutationCommand? = null

        override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?) = error("unused")

        override suspend fun list(
            from: String,
            to: String,
            scope: CalendarScope?,
            group: String?,
            tags: List<String>?,
            importance: Importance?,
            cursor: String?,
            query: String?,
            limit: Int?,
        ): SentientResult<CalendarEventPage> {
            listCalls++
            this.from = from
            this.to = to
            return pageResult
        }

        override suspend fun create(event: CalendarEvent) = error("unused")
        override suspend fun create(input: CalendarCreateInput) = error("unused")

        override suspend fun mutate(eventId: String, command: CalendarMutationCommand): SentientResult<CalendarMutationResult> {
            lastCommand = command
            return mutationResult
        }
    }
}
