package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.mapSettingsResponse
import io.ktor.client.request.get
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.measureTime

private val CALENDAR_HEADERS = headersOf(HttpHeaders.ContentType, "application/json")
private val calendarFixture = Json.parseToJsonElement(CalendarGoldenFixture.JSON).jsonObject
private val fixtureCreate = calendarFixture.getValue("create").toString()
private val fixtureOccurrence = calendarFixture.getValue("occurrence").toString()
private val fixturePage = calendarFixture.getValue("page").toString()

class CalendarHttpClientTest {
    private fun client(engine: MockEngine, requestTimeoutMillis: Long = 15_000L) = CalendarHttpClient(
        HttpClient(engine),
        "wss://gateway.example/api/v1/ws",
        { "calendar-token" },
        requestTimeoutMillis,
    )

    @Test
    fun get_decodesV2OccurrenceAndSendsBearer() = runTest {
        var path = ""
        var auth = ""
        val engine = MockEngine { request ->
            path = request.url.encodedPath
            auth = request.headers[HttpHeaders.Authorization].orEmpty()
            respond("{\"version\":2,\"requestId\":\"r1\",\"body\":$fixtureOccurrence}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }

        val result = withContext(Dispatchers.Default) { client(engine).get("event-example", CalendarScope.PRIVATE) }
        val event = assertIs<AuthResult.Success<CalendarEvent>>(result).value
        assertEquals("/api/v1/calendar/events/event-example", path)
        assertEquals("Bearer calendar-token", auth)
        assertEquals("event-example", event.id)
        assertEquals("event-example@2026-08-10T09:00-04:00", event.occurrenceId)
        assertEquals(3, event.revision)
        assertTrue(event.recurring)
        assertEquals("2026-08-10T09:00-04:00", event.start.toWireValue())
    }

    @Test
    fun list_usesRawTemporalValuesAndReturnsCursor() = runTest {
        var requestUrl = ""
        val engine = MockEngine { request ->
            requestUrl = request.url.toString()
            respond("{\"version\":2,\"requestId\":\"r2\",\"body\":$fixturePage}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val result = withContext(Dispatchers.Default) {
            client(engine).list(
                CalendarTime.AllDay("2026-08-01"),
                CalendarTime.AllDay("2026-08-31"),
                scope = CalendarScope.ALL,
                group = "family",
                tags = listOf("dinner", "family"),
                importance = Importance.IMPORTANT,
                cursor = "prior-cursor",
                query = "dinner",
                limit = 25,
            )
        }
        val page = assertIs<AuthResult.Success<CalendarEventPage>>(result).value
        assertEquals("opaque-cursor", page.nextCursor)
        assertTrue(requestUrl.contains("from=2026-08-01"), requestUrl)
        assertTrue(requestUrl.contains("to=2026-08-31"), requestUrl)
        assertTrue(requestUrl.contains("scope=all"), requestUrl)
        assertTrue(requestUrl.contains("cursor=prior-cursor"), requestUrl)
        assertTrue(requestUrl.contains("query=dinner"), requestUrl)
        assertFalse(requestUrl.contains("kind%22"), requestUrl)
    }

    @Test
    fun create_emitsOnlyV2CreateFields() = runTest {
        var method = ""
        var path = ""
        var body = ""
        val engine = MockEngine { request ->
            method = request.method.value
            path = request.url.encodedPath
            body = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            respond("{\"version\":2,\"requestId\":\"r3\",\"body\":$fixtureOccurrence}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val draft = CalendarEvent(
            id = "client-only-id",
            scope = CalendarScope.PRIVATE,
            title = "Example event",
            start = CalendarTime.Timed("2026-08-05T09:00-04:00", "America/Toronto"),
            end = CalendarTime.Timed("2026-08-05T10:00-04:00", "America/Toronto"),
            visibility = Visibility.EVERYONE,
            importance = Importance.NORMAL,
            tags = listOf("example"),
            createdAt = "client timestamp",
            updatedAt = "client timestamp",
            occurrenceId = "client occurrence",
            revision = 99,
        )
        assertIs<AuthResult.Success<CalendarEvent>>(withContext(Dispatchers.Default) { client(engine).create(draft) })
        assertEquals("POST", method)
        assertEquals("/api/v1/calendar/events", path)
        val json = Json.parseToJsonElement(body).jsonObject
        assertEquals("private", json.getValue("scope").jsonPrimitive.content)
        assertEquals("2026-08-05T09:00-04:00", json.getValue("start").jsonPrimitive.content)
        assertFalse(json.containsKey("eventId"), body)
        assertFalse(json.containsKey("revision"), body)
        assertFalse(json.containsKey("createdAt"), body)
        assertFalse(json.containsKey("updatedAt"), body)
        assertFalse(json.containsKey("occurrenceId"), body)
    }

    @Test
    fun mutate_supportsEveryScopeAndNeverUsesPatchOrDelete() = runTest {
        val methods = mutableListOf<String>()
        val paths = mutableListOf<String>()
        val bodies = mutableListOf<String>()
        val resultBody = "{\"operation\":\"update\",\"appliedTo\":\"entire_series\",\"eventId\":\"event-example\",\"resultingRevision\":4}"
        val engine = MockEngine { request ->
            methods += request.method.value
            paths += request.url.encodedPath
            bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            respond("{\"version\":2,\"requestId\":\"r4\",\"body\":$resultBody}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val c = client(engine)
        for (scope in CalendarMutationScope.entries) {
            val command = CalendarMutationCommand.update(
                applyTo = scope,
                changes = CalendarChanges(title = "new title"),
                originalStart = if (scope == CalendarMutationScope.ENTIRE_SERIES) null else "2026-08-10T09:00-04:00",
                expectedRevision = 3,
            )
            val result = withContext(Dispatchers.Default) { c.mutate("event-example", command) }
            assertIs<AuthResult.Success<CalendarMutationResult>>(result)
        }
        assertEquals(listOf("POST", "POST", "POST"), methods)
        assertTrue(paths.all { it == "/api/v1/calendar/events/event-example/mutations" })
        assertTrue(bodies.all { !it.contains("eventId") }, bodies.toString())
        assertTrue(bodies[0].contains("this_occurrence"))
        assertTrue(bodies[1].contains("this_and_following"))
        assertTrue(bodies[2].contains("entire_series"))
    }

    @Test
    fun thisOccurrence_update_omitsRecurrenceMemberEntirely() = runTest {
        var body = ""
        val engine = MockEngine { request ->
            body = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            respond(
                "{\"version\":2,\"requestId\":\"r-occurrence\",\"body\":" + calendarFixture.getValue("mutation") + "}",
                HttpStatusCode.OK,
                CALENDAR_HEADERS,
            )
        }
        val command = CalendarMutationCommand.update(
            applyTo = CalendarMutationScope.THIS_OCCURRENCE,
            changes = CalendarChanges(
                title = "occurrence edit",
                recurrence = CalendarPatch.Value(
                    StructuredRecurrence(
                        frequency = RecurrenceFrequency.DAILY,
                        count = 2,
                    ),
                ),
            ),
            originalStart = "2026-08-10T09:00-04:00",
            expectedRevision = 3,
        )
        assertIs<AuthResult.Success<CalendarMutationResult>>(
            withContext(Dispatchers.Default) { client(engine).mutate("event-example", command) },
        )
        val json = Json.parseToJsonElement(body).jsonObject
        assertFalse(json.getValue("changes").jsonObject.containsKey("recurrence"), body)
        assertTrue(body.contains("this_occurrence"), body)
    }

    @Test
    fun calendarChanges_preserveOmissionReplacementAndExplicitClearOnWire() = runTest {
        val bodies = mutableListOf<String>()
        val engine = MockEngine { request ->
            bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            respond(
                "{\"version\":2,\"requestId\":\"r-wire\",\"body\":" + calendarFixture.getValue("mutation") + "}",
                HttpStatusCode.OK,
                CALENDAR_HEADERS,
            )
        }
        val c = client(engine)
        withContext(Dispatchers.Default) {
            c.mutate(
                "event-example",
                CalendarMutationCommand.update(
                    CalendarMutationScope.ENTIRE_SERIES,
                    CalendarChanges(title = "replacement"),
                ),
            )
            c.mutate(
                "event-example",
                CalendarMutationCommand.update(
                    CalendarMutationScope.ENTIRE_SERIES,
                    CalendarChanges(
                        description = CalendarPatch.Clear,
                        end = CalendarPatch.Clear,
                        group = CalendarPatch.Clear,
                        tags = emptyList(),
                        recurrence = CalendarPatch.Clear,
                    ),
                ),
            )
            c.mutate(
                "event-example",
                CalendarMutationCommand.update(
                    CalendarMutationScope.ENTIRE_SERIES,
                    CalendarChanges(
                        description = CalendarPatch.Value("new description"),
                        end = CalendarPatch.Value("2026-08-05T10:00-04:00"),
                        group = CalendarPatch.Value("family"),
                        recurrence = CalendarPatch.Value(
                            StructuredRecurrence(
                                frequency = RecurrenceFrequency.WEEKLY,
                                weekdays = listOf(Weekday.MONDAY, Weekday.WEDNESDAY),
                                count = 6,
                            ),
                        ),
                    ),
                ),
            )
        }
        assertEquals(
            "{\"operation\":\"update\",\"applyTo\":\"entire_series\",\"changes\":{\"title\":\"replacement\"}}",
            bodies[0],
        )
        assertEquals(
            "{\"operation\":\"update\",\"applyTo\":\"entire_series\",\"changes\":{\"description\":null,\"end\":null,\"group\":null,\"tags\":[],\"recurrence\":null}}",
            bodies[1],
        )
        assertEquals(
            "{\"operation\":\"update\",\"applyTo\":\"entire_series\",\"changes\":{\"description\":\"new description\",\"end\":\"2026-08-05T10:00-04:00\",\"group\":\"family\",\"recurrence\":{\"frequency\":\"weekly\",\"weekdays\":[\"monday\",\"wednesday\"],\"count\":6}}}",
            bodies[2],
        )
    }

    @Test
    fun convenienceUpdateAndDeleteMapToEntireSeries() = runTest {
        val bodies = mutableListOf<String>()
        val methods = mutableListOf<String>()
        val resultBody = "{\"operation\":\"update\",\"appliedTo\":\"entire_series\",\"eventId\":\"event-example\",\"resultingRevision\":4}"
        val engine = MockEngine { request ->
            methods += request.method.value
            bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            val body = if (methods.size == 1) resultBody else "{\"operation\":\"delete\",\"appliedTo\":\"entire_series\",\"eventId\":\"event-example\"}"
            respond("{\"version\":2,\"requestId\":\"r5\",\"body\":$body}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val event = CalendarEvent(
            id = "event-example", scope = CalendarScope.PRIVATE, title = "Example event",
            start = CalendarTime.AllDay("2026-08-05"), visibility = Visibility.EVERYONE,
            importance = Importance.NORMAL, revision = 3,
        )
        val updated = withContext(Dispatchers.Default) { client(engine).update(event) }
        assertEquals(4, assertIs<AuthResult.Success<CalendarEvent>>(updated).value.revision)
        assertIs<AuthResult.Failure>(withContext(Dispatchers.Default) { client(engine).delete("event-example") })
        assertIs<AuthResult.Success<Unit>>(withContext(Dispatchers.Default) { client(engine).delete(event) })
        assertEquals(listOf("POST", "POST"), methods)
        assertEquals(
            "{\"operation\":\"update\",\"applyTo\":\"entire_series\",\"changes\":{\"title\":\"Example event\",\"description\":null,\"start\":\"2026-08-05\",\"end\":null,\"visibility\":\"everyone\",\"importance\":\"normal\",\"group\":null,\"tags\":[],\"recurrence\":null},\"scope\":\"private\",\"expectedRevision\":3}",
            bodies[0],
        )
        assertEquals(
            "{\"operation\":\"delete\",\"applyTo\":\"entire_series\",\"scope\":\"private\",\"expectedRevision\":3}",
            bodies[1],
        )
    }

    @Test
    fun cancellationDuringResponseParsingIsRethrown() = runTest {
        val engine = MockEngine {
            respond("{}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        val httpClient = HttpClient(engine)
        val response = httpClient.get("https://gateway.example/calendar/events")
        assertFailsWith<CancellationException> {
            mapSettingsResponse(createLogger("calendar-test"), response) {
                throw CancellationException("parser cancelled")
            }
        }
        httpClient.close()
    }

    @Test
    fun staleRevisionAndDomainErrorRemainInAuthServerEnvelope() = runTest {
        val engine = MockEngine {
            respond(
                "{\"version\":2,\"requestId\":\"request-example\",\"error\":{\"code\":\"conflict\",\"message\":\"revision is stale\"}}",
                HttpStatusCode.Conflict,
                CALENDAR_HEADERS,
            )
        }
        val result = withContext(Dispatchers.Default) {
            client(engine).mutate("event-example", CalendarMutationCommand.delete(CalendarMutationScope.ENTIRE_SERIES))
        }
        val failure = assertIs<AuthResult.Failure>(result)
        val server = assertIs<AuthError.Server>(failure.error)
        assertEquals(409, server.status)
        assertEquals("server-error", server.body)
        assertFalse(server.body.contains("conflict"))
    }

    @Test
    fun calendarRequestIsBoundedByCalendarTimeout() = runTest {
        val requestTimeoutMillis = 100L
        val engine = MockEngine {
            delay(requestTimeoutMillis * 100)
            respond("{}", HttpStatusCode.OK, CALENDAR_HEADERS)
        }
        lateinit var result: AuthResult<CalendarEvent>
        val elapsedMillis = measureTime {
            result = withContext(Dispatchers.Default) { client(engine, requestTimeoutMillis).get("event-example") }
        }.inWholeMilliseconds
        assertIs<AuthResult.Failure>(result)
        assertTrue(elapsedMillis < 1_000L, "request took ${elapsedMillis}ms")
    }
}
