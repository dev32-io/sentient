package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.URLBuilder
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.mapSettingsResponse
import io.sentient.mobilesdk.settings.safeSettingsCall
import io.sentient.mobilesdk.settings.settingsBodyJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import io.ktor.client.statement.bodyAsText

private const val EVENTS_PATH = "/calendar/events"

/** Typed REST access to the gateway-owned family calendar. */
open class CalendarHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("calendar", "calendar-http")

    open suspend fun get(id: String): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        val response = httpClient.get(eventUrl(id)) { bearer() }
        mapBody(response, CalendarEvent.serializer())
    }

    open suspend fun getEvent(id: String): AuthResult<CalendarEvent> = get(id)

    open suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
    ): AuthResult<CalendarEventPage> = safeSettingsCall(log) {
        val url = URLBuilder("$baseUrl$EVENTS_PATH").apply {
            parameters.append("from", settingsBodyJson.encodeToString(CalendarTime.serializer(), from))
            parameters.append("to", settingsBodyJson.encodeToString(CalendarTime.serializer(), to))
            scope?.let { parameters.append("scope", scopeWire(it)) }
            group?.let { parameters.append("group", it) }
            tags?.takeIf { it.isNotEmpty() }?.let { parameters.append("tags", it.joinToString(",")) }
            importance?.let { parameters.append("importance", importanceWire(it)) }
        }.buildString()
        val response = httpClient.get(url) { bearer() }
        mapBody(response, CalendarEventPage.serializer())
    }

    open suspend fun listEvents(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
    ): AuthResult<CalendarEventPage> = list(from, to, scope, group, tags, importance)

    open suspend fun create(event: CalendarEvent): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        val response = httpClient.post("$baseUrl$EVENTS_PATH") { bearer(); jsonBody(CalendarEvent.serializer(), event) }
        mapBody(response, CalendarEvent.serializer())
    }

    open suspend fun createEvent(event: CalendarEvent): AuthResult<CalendarEvent> = create(event)

    open suspend fun update(id: String, event: CalendarEvent): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        val response = httpClient.patch(eventUrl(id)) { bearer(); jsonBody(CalendarEvent.serializer(), event) }
        mapBody(response, CalendarEvent.serializer())
    }

    open suspend fun update(event: CalendarEvent): AuthResult<CalendarEvent> = update(event.id, event)

    open suspend fun updateEvent(event: CalendarEvent): AuthResult<CalendarEvent> = update(event)

    open suspend fun delete(id: String): AuthResult<Unit> = safeSettingsCall(log) {
        val response = httpClient.delete(eventUrl(id)) { bearer() }
        mapSettingsResponse(log, response) { Unit }
    }

    open suspend fun deleteEvent(id: String): AuthResult<Unit> = delete(id)

    private fun eventUrl(id: String) = "$baseUrl$EVENTS_PATH/${id.encodeURLPathPart()}"

    private fun HttpRequestBuilder.bearer() = header(HttpHeaders.Authorization, "Bearer ${token()}")

    private fun <T> HttpRequestBuilder.jsonBody(serializer: KSerializer<T>, value: T) {
        contentType(ContentType.Application.Json)
        setBody(settingsBodyJson.encodeToString(serializer, value))
    }

    private suspend fun <T> mapBody(response: io.ktor.client.statement.HttpResponse, serializer: KSerializer<T>): AuthResult<T> =
        mapSettingsResponse(log, response) {
            val envelope = settingsBodyJson.decodeFromString(CalendarResponse.serializer(serializer), response.bodyAsText())
            envelope.body
        }

    private fun scopeWire(scope: CalendarScope) = if (scope == CalendarScope.PRIVATE) "private" else "household"
    private fun importanceWire(value: Importance) = when (value) {
        Importance.NORMAL -> "normal"
        Importance.IMPORTANT -> "important"
        Importance.PINNED -> "pinned"
    }
}
