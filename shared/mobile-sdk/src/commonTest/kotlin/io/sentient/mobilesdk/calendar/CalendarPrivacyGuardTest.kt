package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.sentient.mobilesdk.vitals.VitalsLogTap
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertFalse

/** Calendar requests may carry content, but calendar diagnostics may not. */
class CalendarPrivacyGuardTest {
    @AfterTest
    fun reset() = VitalsLogTap.clear()

    @Test
    fun real_calendar_paths_never_log_content_bearing_values() = runTest {
        val title = "calendar-title-canary"
        val description = "calendar-description-canary"
        val query = "calendar-query-canary"
        val date = "2026-08-05"
        val mutation = "calendar-mutation-canary"
        val captured = StringBuilder()
        VitalsLogTap.register { _, tag, line -> captured.append(tag).append(' ').append(line).append('\n') }

        val fixture = Json.parseToJsonElement(CalendarGoldenFixture.JSON).jsonObject
        val engine = MockEngine { request ->
            val body = when {
                request.url.encodedPath.endsWith("/mutations") -> "{\"operation\":\"update\",\"appliedTo\":\"entire_series\",\"eventId\":\"event-example\",\"resultingRevision\":4}"
                request.url.encodedPath.endsWith("/calendar/events") && request.method.value == "GET" -> fixture.getValue("page").toString()
                else -> fixture.getValue("occurrence").toString()
            }
            respond("{\"version\":2,\"requestId\":\"privacy\",\"body\":$body}", HttpStatusCode.OK, headersOf("Content-Type", "application/json"))
        }
        val client = CalendarHttpClient(HttpClient(engine), "wss://gateway.example/api/v1/ws", { "token" })
        client.list(
            CalendarTime.AllDay(date), CalendarTime.AllDay(date),
            query = query,
        )
        client.create(
            CalendarEvent(
                id = "draft", scope = CalendarScope.PRIVATE, title = title,
                description = description, start = CalendarTime.AllDay(date),
                visibility = Visibility.EVERYONE, importance = Importance.NORMAL,
            ),
        )
        client.mutate(
            "event-example",
            CalendarMutationCommand.update(
                CalendarMutationScope.ENTIRE_SERIES,
                CalendarChanges(title = mutation, description = CalendarPatch.Value(description)),
            ),
        )

        val log = captured.toString()
        assertFalse(log.contains(title), log)
        assertFalse(log.contains(description), log)
        assertFalse(log.contains(query), log)
        assertFalse(log.contains(date), log)
        assertFalse(log.contains(mutation), log)
        assertFalse(log.contains("token"), log)
    }
}
