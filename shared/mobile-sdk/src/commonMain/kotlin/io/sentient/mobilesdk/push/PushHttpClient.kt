package io.sentient.mobilesdk.push

import io.ktor.client.HttpClient
import io.ktor.client.request.*
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.mapSettingsResponse
import io.sentient.mobilesdk.settings.safeSettingsCall
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

private const val REGISTRATIONS_PATH = "/push/registrations"
private const val PREFERENCES_PATH = "/push/preferences"
private const val REVOCATIONS_PATH = "/push/revocations"
internal val pushJson = Json { ignoreUnknownKeys = false; encodeDefaults = false; explicitNulls = false }

/** Push transport. Revoke deliberately sends no account bearer token. */
open class PushHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
    private val requestTimeoutMillis: Long = 15_000L,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("push", "http")

    open suspend fun register(request: PushRegistrationRequest): AuthResult<PushRegistrationResponse> = call {
        request.validate()
        decode(httpClient.post("$baseUrl$REGISTRATIONS_PATH") { bearer(); body(PushRegistrationRequest.serializer(), request) }, PushRegistrationResponse.serializer()) { it.validate() }
    }
    open suspend fun preferences(installationId: String): AuthResult<PushPreferenceGetResponse> = call {
        require(installationId.isNotBlank() && installationId.length <= 200)
        val url = URLBuilder("$baseUrl$PREFERENCES_PATH").apply { parameters.append("installationId", installationId) }.buildString()
        decode(httpClient.get(url) { bearer() }, PushPreferenceGetResponse.serializer()) { it.binding.validate(); require(it.binding.installationId == installationId) }
    }
    open suspend fun patchPreferences(request: PushPreferencePatchRequest): AuthResult<PushPreferencePatchResponse> = call {
        request.validate()
        decode(httpClient.patch("$baseUrl$PREFERENCES_PATH") { bearer(); body(PushPreferencePatchRequest.serializer(), request) }, PushPreferencePatchResponse.serializer()) {
            it.binding.validate(); require(it.binding.bindingId == request.bindingId && it.binding.generation == request.generation)
        }
    }
    open suspend fun revoke(request: PushRevokeRequest): AuthResult<PushRevokeAcknowledgement> = call {
        request.validate()
        decode(httpClient.post("$baseUrl$REVOCATIONS_PATH") { body(PushRevokeRequest.serializer(), request) }, PushRevokeAcknowledgement.serializer()) {
            it.validate(); require(it.bindingId == request.bindingId && it.generation == request.generation)
        }
    }

    private suspend fun <T> call(block: suspend () -> AuthResult<T>): AuthResult<T> = safeSettingsCall(log) { withTimeout(requestTimeoutMillis) { block() } }
    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>, validate: (T) -> Unit): AuthResult<T> =
        mapSettingsResponse(log, response) { valueResponse -> pushJson.decodeFromString(serializer, valueResponse.bodyAsText()).also(validate) }
    private fun HttpRequestBuilder.bearer() = header(HttpHeaders.Authorization, "Bearer ${token()}")
    private fun <T> HttpRequestBuilder.body(serializer: KSerializer<T>, value: T) { contentType(ContentType.Application.Json); setBody(pushJson.encodeToString(serializer, value)) }
}
