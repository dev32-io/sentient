package io.sentient.mobiledata.calendar

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondOk
import io.ktor.client.HttpClient
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.data.calendar.SdkCalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.calendar.CalendarUseCases
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.CalendarTime
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class CalendarDataTest {
    private val time = CalendarTime.AllDay("2026-08-01")
    private val event = CalendarEvent("event-1", CalendarScope.HOUSEHOLD, "Dinner", start = time, visibility = Visibility.EVERYONE, importance = Importance.NORMAL, createdAt = "now", updatedAt = "now")

    @Test
    fun repository_maps_sdk_success_and_failure_to_envelope() = kotlinx.coroutines.test.runTest {
        val client = FakeCalendarClient(AuthResult.Success(event))
        val repository = SdkCalendarRepository(client)
        assertEquals(SentientResult.Success(event), repository.get("event-1"))

        val failing = SdkCalendarRepository(FakeCalendarClient(AuthResult.Failure(AuthError.InvalidCredentials)))
        assertIs<SentientResult.Failure>(failing.get("event-1"))
    }

    @Test
    fun usecase_folds_latest_list_result_into_state() = kotlinx.coroutines.test.runTest {
        val page = CalendarEventPage(listOf(event), 0)
        val repository = FakeRepository(SentientResult.Success(page))
        val useCases = CalendarUseCases(repository)
        assertEquals(SentientResult.Success(page), useCases.list(time, time))
        assertEquals(SentientResult.Success(page), useCases.listState.value)
    }

    private class FakeCalendarClient(private val result: AuthResult<CalendarEvent>) :
        CalendarHttpClient(HttpClient(MockEngine { respondOk() }), "ws://localhost", { "token" }) {
        override suspend fun get(id: String): AuthResult<CalendarEvent> = result
    }

    private class FakeRepository(private val page: SentientResult<CalendarEventPage>) : CalendarRepository {
        override suspend fun get(id: String) = error("unused")
        override suspend fun list(from: CalendarTime, to: CalendarTime, scope: CalendarScope?, group: String?, tags: List<String>?, importance: Importance?) = page
        override suspend fun create(event: CalendarEvent) = error("unused")
        override suspend fun update(id: String, event: CalendarEvent) = error("unused")
        override suspend fun delete(id: String) = error("unused")
    }
}
