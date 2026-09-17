package io.sentient.mobilesdk.scheduling

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.*
import io.ktor.http.content.OutgoingContent
import io.ktor.http.content.TextContent
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

    @Test fun clearCallsEncodeFrozenBulkTargetsAndRequireStrictTrueAck() = runBlocking {
        var calls = 0
        val engine = MockEngine { request ->
            assertEquals(HttpMethod.Delete, request.method)
            assertEquals("Bearer token", request.headers[HttpHeaders.Authorization])
            when (calls++) {
                0 -> {
                    assertIs<OutgoingContent.NoContent>(request.body)
                    assertNull(request.headers[HttpHeaders.ContentType])
                    assertEquals("/api/v1/scheduled-session-cards/session%20one", request.url.encodedPath)
                    respond("""{"cleared":true}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()))
                }
                1 -> {
                    assertEquals("/api/v1/scheduled-session-cards", request.url.encodedPath)
                    assertEquals(ContentType.Application.Json, request.body.contentType)
                    assertEquals("""{"occurrenceIds":["occ-one","occ-two"]}""", assertIs<TextContent>(request.body).text)
                    respond("""{"cleared":false}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()))
                }
                else -> error("unexpected request")
            }
        }
        val client = ScheduleHttpClient(HttpClient(engine), "wss://example.test/api/v1/ws", { "token" })

        assertTrue(assertIs<AuthResult.Success<ScheduledSessionCardsClearResponse>>(client.clearCard("session one")).value.cleared)
        assertIs<AuthError.Unknown>(assertIs<AuthResult.Failure>(client.clearCards(listOf("occ-one", "occ-two"))).error)
        assertTrue(assertIs<AuthResult.Success<ScheduledSessionCardsClearResponse>>(client.clearCards(emptyList())).value.cleared)
        assertEquals(2, calls)
    }

    @Test fun bulkClearRejectsMalformedOccurrenceIdsWithoutNetwork() = runBlocking {
        var calls = 0
        val client = ScheduleHttpClient(HttpClient(MockEngine { calls += 1; error("unexpected request") }), "wss://example.test/api/v1/ws", { "token" })

        assertIs<AuthResult.Failure>(client.clearCards(listOf("same", "same")))
        assertIs<AuthResult.Failure>(client.clearCards(listOf("")))
        assertEquals(0, calls)
    }

    @Test fun clearRejectsUnknownAckFieldsAndPreservesHttpErrors() = runBlocking {
        var calls = 0
        val client = ScheduleHttpClient(HttpClient(MockEngine {
            when (calls++) {
                0 -> respond("""{"cleared":true,"extra":1}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()))
                else -> respond("""{"error":{"code":"not_found","retryable":false,"message":"missing"}}""", HttpStatusCode.NotFound, headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()))
            }
        }), "wss://example.test/api/v1/ws", { "token" })

        assertIs<AuthError.Unknown>(assertIs<AuthResult.Failure>(client.clearCards(listOf("occ-one"))).error)
        val error = assertIs<AuthError.Server>(assertIs<AuthResult.Failure>(client.clearCard("missing")).error)
        assertEquals(404, error.status)
    }
}
