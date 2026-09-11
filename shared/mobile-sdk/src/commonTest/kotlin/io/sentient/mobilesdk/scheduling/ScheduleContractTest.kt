package io.sentient.mobilesdk.scheduling

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.calendar.CalendarReminderInput
import io.sentient.mobilesdk.calendar.CalendarReminderOutput
import io.sentient.mobilesdk.calendar.validate
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlin.test.*

class ScheduleContractTest {
    private val root = Json.parseToJsonElement(ScheduleGoldenFixture.JSON).jsonObject

    @Test fun goldenInputsAndCardsMatchProtocolFixture() {
        val json = Json { ignoreUnknownKeys = false; encodeDefaults = false; explicitNulls = false }
        listOf("onceAtCreate", "onceAfterCreate", "weeklyCreate", "monthlyCreate").forEach { key ->
            val decoded = json.decodeFromJsonElement(ScheduleCreateRequest.serializer(), root.getValue(key))
            decoded.validate()
            assertEquals(root.getValue(key).jsonObject.getValue("timing"), json.encodeToJsonElement(ScheduleCreateRequest.serializer(), decoded).jsonObject.getValue("timing"))
        }
        val page = json.decodeFromJsonElement(ScheduledSessionCardPage.serializer(), root.getValue("cards"))
        page.cards.forEach(ScheduledSessionCard::validate)
        assertEquals(2, page.cards.size)

        val reminders = root.getValue("calendarReminderStates").jsonObject
        assertFalse(reminders.getValue("createOmitted").jsonObject.containsKey("reminder"))
        json.decodeFromJsonElement(CalendarReminderInput.serializer(), reminders.getValue("enabledAtStart")).validate(create = true)
        json.decodeFromJsonElement(CalendarReminderInput.serializer(), reminders.getValue("disabled")).validate()
        json.decodeFromJsonElement(CalendarReminderOutput.serializer(), reminders.getValue("allDayLinkedOutput")).validate()
    }

    @Test fun malformedCompletedCardIsTypedProtocolFailure() {
        runBlocking {
            val malformed = """{"cards":[{"sessionId":"s","scheduleId":"x","occurrenceId":"o","intendedAt":"2026-08-01T15:30:00Z","completedAt":"2026-08-01T15:31:00Z","status":"completed"}]}"""
            val client = ScheduleHttpClient(HttpClient(MockEngine { respond(malformed, HttpStatusCode.OK, headersOf("Content-Type", "application/json")) }), "wss://example.test/api/v1/ws", { "token" })
            val result = client.cards()
            assertIs<AuthResult.Failure>(result)
            assertIs<AuthError.Unknown>(result.error)
        }
    }
}
