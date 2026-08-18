package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.auth.AuthResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.system.measureTimeMillis

private val CALENDAR_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private const val EVENT = """{
  "id":"event-1","scope":"household","title":"Dinner",
  "start":{"kind":"timed","instant":"2026-08-05T13:00:00.000Z","timeZoneId":"America/Toronto"},
  "visibility":"everyone","importance":"important","tags":["family"],
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
        assertEquals("America/Toronto", (event.start as CalendarTime.Timed).timeZoneId)
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
