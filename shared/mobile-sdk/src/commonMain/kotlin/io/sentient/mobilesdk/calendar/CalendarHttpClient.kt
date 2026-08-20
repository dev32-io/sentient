package io.sentient.mobilesdk.calendar

import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.URLBuilder
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.mapSettingsResponse
import io.sentient.mobilesdk.settings.safeSettingsCall
import io.sentient.mobilesdk.settings.settingsBodyJson
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

private const val EVENTS_PATH = "/calendar/events"

/** Typed REST V2 access to the gateway-owned family calendar. */
open class CalendarHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
    private val requestTimeoutMillis: Long = 15_000L,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("calendar", "calendar-http")

    open suspend fun get(
        id: String,
        scope: CalendarScope? = null,
        originalStart: String? = null,
    ): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        withTimeout(requestTimeoutMillis) {
            val url = URLBuilder(eventUrl(id)).apply {
                scope?.let { parameters.append("scope", scopeWire(it)) }
                originalStart?.let { parameters.append("originalStart", it) }
            }.buildString()
            val response = httpClient.get(url) { bearer() }
            mapBody(response) { body ->
                val element = body.jsonObject
                if (element.containsKey("occurrenceId")) {
                    settingsBodyJson.decodeFromJsonElement(EffectiveOccurrence.serializer(), element).toCompatibility()
                } else {
                    settingsBodyJson.decodeFromJsonElement(CalendarEventV2.serializer(), element).toCompatibility()
                }
            }
        }
    }

    open suspend fun get(id: String, originalStart: CalendarTime, scope: CalendarScope? = null): AuthResult<CalendarEvent> =
        get(id, scope, originalStart.toWireValue())

    open suspend fun getEvent(id: String): AuthResult<CalendarEvent> = get(id)

    open suspend fun getEvent(id: String, originalStart: String, scope: CalendarScope? = null): AuthResult<CalendarEvent> =
        get(id, scope, originalStart)

    open suspend fun list(
        from: String,
        to: String,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null,
    ): AuthResult<CalendarEventPage> = list(from.toCalendarTime(), to.toCalendarTime(), scope, group, tags, importance, cursor, query, limit)

    open suspend fun list(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null,
    ): AuthResult<CalendarEventPage> = safeSettingsCall(log) {
        withTimeout(requestTimeoutMillis) {
            val url = URLBuilder("$baseUrl$EVENTS_PATH").apply {
                // V2 query temporal values are raw date/RFC3339 strings, never JSON objects.
                parameters.append("from", from.toWireValue())
                parameters.append("to", to.toWireValue())
                scope?.let { parameters.append("scope", scopeWire(it)) }
                group?.let { parameters.append("group", it) }
                tags?.takeIf { it.isNotEmpty() }?.let { parameters.append("tags", it.joinToString(",")) }
                importance?.let { parameters.append("importance", importanceWire(it)) }
                cursor?.let { parameters.append("cursor", it) }
                query?.let { parameters.append("query", it) }
                limit?.let { parameters.append("limit", it.toString()) }
            }.buildString()
            val response = httpClient.get(url) { bearer() }
            mapBody(response, CalendarPage.serializer()) { page ->
                val events = page.events.map(EffectiveOccurrence::toCompatibility)
                CalendarEventPage(events = events, more = if (page.nextCursor != null) 1 else 0, nextCursor = page.nextCursor)
            }
        }
    }

    open suspend fun listEvents(
        from: CalendarTime,
        to: CalendarTime,
        scope: CalendarScope? = null,
        group: String? = null,
        tags: List<String>? = null,
        importance: Importance? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null,
    ): AuthResult<CalendarEventPage> = list(from, to, scope, group, tags, importance, cursor, query, limit)

    open suspend fun create(input: CalendarCreateInput): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        withTimeout(requestTimeoutMillis) {
            val response = httpClient.post("$baseUrl$EVENTS_PATH") {
                bearer()
                jsonBody(CalendarCreateInput.serializer(), input)
            }
            mapBody(response, CalendarEventV2.serializer()) { it.toCompatibility() }
        }
    }

    open suspend fun create(event: CalendarEvent): AuthResult<CalendarEvent> = create(event.toCreateInput())

    open suspend fun createEvent(event: CalendarEvent): AuthResult<CalendarEvent> = create(event)

    /** Posts a typed command only to POST /calendar/events/{eventId}/mutations. */
    open suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): AuthResult<CalendarMutationResult> = safeSettingsCall(log) {
        withTimeout(requestTimeoutMillis) {
            val response = httpClient.post("${eventUrl(eventId)}/mutations") {
                bearer()
                jsonBody(CalendarMutationCommand.serializer(), command)
            }
            mapBody(response, CalendarMutationResult.serializer()) { it }
        }
    }

    /** Existing update callers retain whole-series semantics through V2 commands. */
    open suspend fun update(id: String, event: CalendarEvent): AuthResult<CalendarEvent> = safeSettingsCall(log) {
        val command = CalendarMutationCommand.update(
            applyTo = CalendarMutationScope.ENTIRE_SERIES,
            changes = event.toChanges(),
            scope = event.scope.takeUnless { it == CalendarScope.ALL },
            expectedRevision = event.revision.takeIf { it > 0 },
        )
        when (val result = mutate(id, command)) {
            is AuthResult.Failure -> result
            is AuthResult.Success -> AuthResult.Success(
                event.copy(
                    id = result.value.eventId,
                    revision = result.value.resultingRevision ?: event.revision,
                    occurrenceId = null,
                    baseEventId = null,
                ),
            )
        }
    }

    open suspend fun update(event: CalendarEvent): AuthResult<CalendarEvent> = update(event.persistedId, event)

    open suspend fun updateEvent(event: CalendarEvent): AuthResult<CalendarEvent> = update(event)

    /**
     * Source-compatible id-only adapter. It cannot prove writable scope or
     * expected revision, so it fails closed without issuing a write.
     */
    open suspend fun delete(id: String): AuthResult<Unit> =
        AuthResult.Failure(AuthError.Unknown("calendar delete requires a selected event"))

    /** Selected-event adapter preserves its writable scope and optimistic revision. */
    open suspend fun delete(event: CalendarEvent): AuthResult<Unit> = safeSettingsCall(log) {
        when (val result = mutate(
            event.persistedId,
            CalendarMutationCommand.delete(
                applyTo = CalendarMutationScope.ENTIRE_SERIES,
                scope = event.scope.takeUnless { it == CalendarScope.ALL },
                expectedRevision = event.revision.takeIf { it > 0 },
            ),
        )) {
            is AuthResult.Failure -> result
            is AuthResult.Success -> AuthResult.Success(Unit)
        }
    }

    open suspend fun deleteEvent(id: String): AuthResult<Unit> = delete(id)

    open suspend fun deleteEvent(event: CalendarEvent): AuthResult<Unit> = delete(event)

    private fun CalendarEvent.toChanges() = CalendarChanges(
        title = title,
        // Update adapters treat the compatibility event as a full replacement:
        // nullable fields are explicit clears, not accidental omissions.
        description = description?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
        start = start.toWireValue(),
        end = end?.toWireValue()?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
        visibility = visibility,
        importance = importance,
        group = group?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
        tags = tags,
        recurrence = recurrence?.let { CalendarPatch.Value(it) } ?: CalendarPatch.Clear,
    )

    private fun eventUrl(id: String) = "$baseUrl$EVENTS_PATH/${id.encodeURLPathPart()}"

    private fun HttpRequestBuilder.bearer() = header(HttpHeaders.Authorization, "Bearer ${token()}")

    private fun <T> HttpRequestBuilder.jsonBody(serializer: KSerializer<T>, value: T) {
        contentType(ContentType.Application.Json)
        setBody(settingsBodyJson.encodeToString(serializer, value))
    }

    private suspend fun <T, R> mapBody(
        response: HttpResponse,
        serializer: KSerializer<T>,
        map: (T) -> R,
    ): AuthResult<R> = mapSettingsResponse(log, response) {
        val envelope = settingsBodyJson.decodeFromString(CalendarResponse.serializer(serializer), response.bodyAsText())
        map(envelope.body)
    }

    private suspend fun <T> mapBody(
        response: HttpResponse,
        map: (JsonElement) -> T,
    ): AuthResult<T> = mapSettingsResponse(log, response) {
        val envelope = settingsBodyJson.decodeFromString(
            CalendarResponse.serializer(JsonElement.serializer()),
            response.bodyAsText(),
        )
        map(envelope.body)
    }

    private fun scopeWire(scope: CalendarScope) = when (scope) {
        CalendarScope.PRIVATE -> "private"
        CalendarScope.HOUSEHOLD -> "household"
        CalendarScope.ALL -> "all"
    }

    private fun importanceWire(value: Importance) = when (value) {
        Importance.NORMAL -> "normal"
        Importance.IMPORTANT -> "important"
        Importance.PINNED -> "pinned"
    }
}
