package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.http.content.OutgoingContent
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.system.measureTimeMillis

private val CALENDAR_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private val calendarFixture = Json.parseToJsonElement(CalendarGoldenFixture.JSON).jsonObject
private val fixtureTimed = calendarFixture.getValue("timed").toString()
private val fixtureOccurrenceStart = calendarFixture.getValue("listOccurrence").jsonObject.getValue("start").toString()

private val EVENT = """{
  "id":"event-1","scope":"household","title":"Dinner",
  "start":$fixtureTimed,
  "visibility":"everyone","importance":"important","tags":["family"],
  "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"
}"""

private val OCCURRENCE_EVENT = """{
  "id":"occurrence-1","baseEventId":"event-1","occurrenceId":"occurrence-1",
  "scope":"household","title":"Dinner",
  "start":$fixtureOccurrenceStart,
  "visibility":"everyone","importance":"important","tags":[],
  "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"
}"""

class CalendarHttpClientTest {
    private fun client(engine: MockEngine, requestTimeoutMillis: Long = 15_000L) = CalendarHttpClient(
        HttpClient(engine) { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } },
        "wss://gateway.example/api/v1/ws",
        { "calendar-token" },
        requestTimeoutMillis,
    )

    @Test
    fun get_decodesGoldenTimedValueAndSendsBearer() = runTest {
        var path = ""
        var auth = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            auth = request.headers[HttpHeaders.Authorization].orEmpty()
            respond("""{"version":1,"requestId":"r1","body":$EVENT}""", HttpStatusCode.OK, CALENDAR_HEADERS)
        }

        val result = withContext(Dispatchers.Default) { client(engine).get("event-1") }
        val event = assertIs<AuthResult.Success<CalendarEvent>>(result).value
        assertEquals("/api/v1/calendar/events/event-1", path)
        assertEquals("Bearer calendar-token", auth)
        assertEquals(calendarFixture.getValue("timed").jsonObject.getValue("timeZoneId").jsonPrimitive.content, (event.start as CalendarTime.Timed).timeZoneId)
        assertEquals(listOf("family"), event.tags)
    }

    @Test
    fun calendarRequestIsBoundedByCalendarTimeout() = runTest {
        val requestTimeoutMillis = 100L
        val engine = MockEngine {
            delay(requestTimeoutMillis * 100)
            respond("{}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }

        lateinit var result: AuthResult<CalendarEvent>
        val elapsedMillis = measureTimeMillis {
            result = withContext(Dispatchers.Default) {
                client(engine, requestTimeoutMillis).get("event-1")
            }
        }

        assertIs<AuthResult.Failure>(result)
        assertTrue(elapsedMillis < 1_000L, "request took ${elapsedMillis}ms")
    }

    @Test
    fun occurrence_rows_preserve_both_id_fields_and_use_base_id_for_mutation() = runTest {
        var path = ""
        var body = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            if (request.method.value == "PATCH") {
                body = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            }
            val body = if (request.method.value == "GET")
                "{\"events\":[$OCCURRENCE_EVENT],\"more\":0}"
            else OCCURRENCE_EVENT
            respond("{\"version\":1,\"requestId\":\"r3\",\"body\":$body}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val pageResult = withContext(Dispatchers.Default) {
            client(engine).list(CalendarTime.AllDay("2026-08-01"), CalendarTime.AllDay("2026-08-31"))
        }
        val occurrence = assertIs<AuthResult.Success<CalendarEventPage>>(pageResult).value.events.single()
        assertEquals("event-1", occurrence.id)
        assertEquals("occurrence-1", occurrence.occurrenceId)
        assertEquals("event-1", occurrence.baseEventId)
        assertEquals("event-1", occurrence.persistedId)
        withContext(Dispatchers.Default) { client(engine).update(occurrence) }
        assertEquals("/api/v1/calendar/events/event-1", path)
        assertFalse(body.contains("occurrenceId"), body)
        assertFalse(body.contains("baseEventId"), body)
    }

    @Test
    fun create_omits_server_owned_timestamps_and_occurrence_metadata() = runTest {
        var body = ""
        val engine = MockEngine { request ->
            body = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            respond("{\"version\":1,\"requestId\":\"r4\",\"body\":$EVENT}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val draft = CalendarEvent(
            id = "draft", scope = CalendarScope.HOUSEHOLD, title = "Draft",
            start = CalendarTime.AllDay("2026-08-05"), visibility = Visibility.EVERYONE,
            importance = Importance.NORMAL, createdAt = "", updatedAt = "",
            occurrenceId = "occurrence-ignored", baseEventId = "event-ignored",
        )
        val createResult = withContext(Dispatchers.Default) { client(engine).create(draft) }
        assertIs<AuthResult.Success<CalendarEvent>>(createResult)
        assertFalse(body.contains("createdAt"), body)
        assertFalse(body.contains("updatedAt"), body)
        assertFalse(body.contains("occurrenceId"), body)
        assertFalse(body.contains("baseEventId"), body)
    }

    @Test
    fun list_encodesTimeWindowAndMapsPage() = runTest {
        var url = ""
        val engine = MockEngine { request ->
            url = request.url.toString()
            respond("""{"version":1,"requestId":"r2","body":{"events":[$EVENT],"more":0}}""", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val result = withContext(Dispatchers.Default) {
            client(engine).list(
                CalendarTime.AllDay("2026-08-01"),
                CalendarTime.AllDay("2026-08-31"),
                scope = CalendarScope.HOUSEHOLD,
            )
        }
        val page = assertIs<AuthResult.Success<CalendarEventPage>>(result).value
        assertEquals(1, page.events.size)
        assertTrue(url.contains("scope=household"), url)
        assertTrue(url.contains("2026-08-01"), url)
    }
}
