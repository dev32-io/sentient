package io.sentient.mobiledata.di

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.sentient.mobiledata.data.calendar.SdkCalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class CalendarDependencyTest {
    @Test
    fun `protected settings boundary never falls back to network repository`() = runTest {
        var networkCalls = 0
        val client = HttpClient(MockEngine {
            networkCalls += 1
            error("content-bearing transport failure")
        })
        try {
            val dependency = CalendarDependencyBoundary.unavailable(
                CalendarDependencyUnavailableReason.PROTECTED_STORAGE,
            )
            val settings = SettingsComponent(
                httpClient = client,
                gatewayWsUrl = "ws://example.test/api/v1/ws",
                token = { "token" },
                calendarDependency = dependency,
            )

            val result = settings.calendarRepository.list(
                from = "2026-06-01",
                to = "2026-07-01",
                scope = CalendarScope.ALL,
            )
            val failure = assertIs<SentientResult.Failure>(result)
            assertIs<SentientError.Protocol>(failure.error)
            assertEquals("Calendar persistence is unavailable.", failure.error.userMessage)
            assertEquals(0, networkCalls)
            assertEquals(
                CalendarDependencyUnavailableReason.PROTECTED_STORAGE,
                (settings.calendarDependencyState as CalendarDependencyState.Unavailable).reason,
            )
        } finally {
            client.close()
        }
    }

    @Test
    fun `legacy settings construction remains the explicit non-persistent path`() {
        val client = HttpClient(MockEngine { error("unused network") })
        try {
            val settings = SettingsComponent(
                httpClient = client,
                gatewayWsUrl = "ws://example.test/api/v1/ws",
                token = { "token" },
            )
            assertIs<SdkCalendarRepository>(settings.calendarRepository)
        } finally {
            client.close()
        }
    }
}
