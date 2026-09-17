package io.sentient.mobilesdk.scheduling

import io.ktor.client.HttpClient
import io.ktor.client.request.*
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.sentient.mobilesdk.auth.AuthError
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.mapSettingsResponse
import io.sentient.mobilesdk.settings.safeSettingsCall
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

private const val SCHEDULES_PATH = "/schedules"
private const val CARDS_PATH = "/scheduled-session-cards"
private val scheduleJson = Json { ignoreUnknownKeys = false; encodeDefaults = false; explicitNulls = false }

/** Strict, bounded REST adapter for the frozen scheduling contract. */
open class ScheduleHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
    private val requestTimeoutMillis: Long = 15_000L,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("scheduling", "http")

    open suspend fun create(request: ScheduleCreateRequest): AuthResult<ScheduleCreateResponse> = call {
        request.validate()
        decode(httpClient.post("$baseUrl$SCHEDULES_PATH") { bearer(); body(ScheduleCreateRequest.serializer(), request) }, ScheduleCreateResponse.serializer()) { it.schedule.validate() }
    }

    open suspend fun list(cursor: String? = null, limit: Int? = null): AuthResult<ScheduleListResponse> = call {
        require(limit == null || limit in 1..100)
        val url = URLBuilder("$baseUrl$SCHEDULES_PATH").apply {
            cursor?.let { require(it.isNotBlank()); parameters.append("cursor", it) }
            limit?.let { parameters.append("limit", it.toString()) }
        }.buildString()
        decode(httpClient.get(url) { bearer() }, ScheduleListResponse.serializer()) {
            require(it.schedules.size <= 100); it.schedules.forEach(Schedule::validate); require(it.nextCursor?.isNotBlank() != false)
        }
    }

    open suspend fun patch(scheduleId: String, request: SchedulePatchRequest): AuthResult<SchedulePatchResponse> = call {
        require(scheduleId.isNotBlank()); request.validate()
        decode(httpClient.patch(itemUrl(scheduleId)) { bearer(); body(SchedulePatchRequest.serializer(), request) }, SchedulePatchResponse.serializer()) { it.schedule.validate(); require(it.schedule.scheduleId == scheduleId) }
    }

    open suspend fun delete(scheduleId: String, expectedRevision: Int): AuthResult<ScheduleDeleteResponse> = call {
        require(scheduleId.isNotBlank() && expectedRevision > 0)
        decode(httpClient.delete(itemUrl(scheduleId)) { bearer(); body(ScheduleDeleteRequest.serializer(), ScheduleDeleteRequest(expectedRevision)) }, ScheduleDeleteResponse.serializer()) { require(it.deleted && it.scheduleId == scheduleId) }
    }

    open suspend fun cards(cursor: String? = null, limit: Int? = null): AuthResult<ScheduledSessionCardPage> = call {
        require(limit == null || limit in 1..100)
        val url = URLBuilder("$baseUrl$CARDS_PATH").apply {
            cursor?.let { require(it.isNotBlank()); parameters.append("cursor", it) }
            limit?.let { parameters.append("limit", it.toString()) }
        }.buildString()
        decode(httpClient.get(url) { bearer() }, ScheduledSessionCardPage.serializer()) {
            require(it.cards.size <= 100); it.cards.forEach(ScheduledSessionCard::validate); require(it.nextCursor?.isNotBlank() != false)
        }
    }

    open suspend fun clearCard(sessionId: String): AuthResult<ScheduledSessionCardsClearResponse> = call {
        require(sessionId.isNotBlank())
        decode(
            httpClient.delete("$baseUrl$CARDS_PATH/${sessionId.encodeURLPathPart()}") { bearer() },
            ScheduledSessionCardsClearResponse.serializer(),
            ScheduledSessionCardsClearResponse::validate,
        )
    }

    open suspend fun clearCards(occurrenceIds: List<String>): AuthResult<ScheduledSessionCardsClearResponse> {
        if (occurrenceIds.isEmpty()) return AuthResult.Success(ScheduledSessionCardsClearResponse(true))
        val request = ScheduledSessionCardsClearRequest(occurrenceIds.toList())
        return call {
            request.validate()
            decode(
                httpClient.delete("$baseUrl$CARDS_PATH") {
                    bearer()
                    body(ScheduledSessionCardsClearRequest.serializer(), request)
                },
                ScheduledSessionCardsClearResponse.serializer(),
                ScheduledSessionCardsClearResponse::validate,
            )
        }
    }

    private suspend fun <T> call(block: suspend () -> AuthResult<T>): AuthResult<T> = safeSettingsCall(log) { withTimeout(requestTimeoutMillis) { block() } }
    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>, validate: (T) -> Unit): AuthResult<T> {
        if (!response.status.isSuccess()) return mapSettingsResponse(log, response) { error("unreachable") }
        return try {
            AuthResult.Success(scheduleJson.decodeFromString(serializer, response.bodyAsText()).also(validate))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            AuthResult.Failure(AuthError.Unknown("decode-failure"))
        }
    }
    private fun itemUrl(id: String) = "$baseUrl$SCHEDULES_PATH/${id.encodeURLPathPart()}"
    private fun HttpRequestBuilder.bearer() = header(HttpHeaders.Authorization, "Bearer ${token()}")
    private fun <T> HttpRequestBuilder.body(serializer: KSerializer<T>, value: T) { contentType(ContentType.Application.Json); setBody(scheduleJson.encodeToString(serializer, value)) }
}
