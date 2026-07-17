// ---------------------------------------------------------------------------
// AdminHttpClient — admin-only REST client for member management + integration
// secrets (gateway/src/api/handlers/admin.ts + secrets.ts).
//
// SECURITY: key material is WRITE-ONLY. GET /admin/secrets returns booleans
// only; PUT bodies carry the raw value but are NEVER logged (only provider name
// + a hasKey/hasBaseUrl boolean).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger
import kotlinx.serialization.KSerializer

private const val PATH_USERS = "/admin/users"
private const val PATH_SECRETS = "/admin/secrets"
private const val PATH_SECRETS_LLM = "/admin/secrets/llm"
private const val PATH_SECRETS_LLM_ACTIVE = "/admin/secrets/llm/active"
private const val RESET_PIN_SUFFIX = "/reset-pin"

/** Admin REST client for the `/api/v1/admin` routes. */
open class AdminHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "admin-http")

    // ── Members ──

    open suspend fun listUsers(): AuthResult<List<UserSummary>> = safeSettingsCall(log) {
        log.debug("listUsers")
        val resp = httpClient.get("$baseUrl$PATH_USERS") { bearer() }
        mapSettingsResponse(log, resp) { it.body<UserListResponse>().users }
    }

    open suspend fun createUser(request: CreateUserRequest): AuthResult<UserSummary> = safeSettingsCall(log) {
        log.info("createUser", mapOf("displayNameLen" to request.displayName.length, "isAdmin" to request.isAdmin))
        val resp = httpClient.post("$baseUrl$PATH_USERS") {
            bearer(); jsonBody(CreateUserRequest.serializer(), request)
        }
        mapSettingsResponse(log, resp) { it.body<UserEnvelope>().user }
    }

    open suspend fun setUserAdmin(userId: String, isAdmin: Boolean): AuthResult<UserSummary> = safeSettingsCall(log) {
        log.info("setUserAdmin", mapOf("userId" to userId, "isAdmin" to isAdmin))
        val resp = httpClient.patch("$baseUrl$PATH_USERS/${userId.encodeURLPathPart()}") {
            bearer(); jsonBody(PatchUserRequest.serializer(), PatchUserRequest(isAdmin))
        }
        mapSettingsResponse(log, resp) { it.body<UserEnvelope>().user }
    }

    open suspend fun deleteUser(userId: String): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("deleteUser", mapOf("userId" to userId))
        val resp = httpClient.delete("$baseUrl$PATH_USERS/${userId.encodeURLPathPart()}") { bearer() }
        mapSettingsResponse(log, resp) { }
    }

    open suspend fun resetPin(userId: String, pin: String): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("resetPin", mapOf("userId" to userId)) // pin NEVER logged
        val resp = httpClient.post("$baseUrl$PATH_USERS/${userId.encodeURLPathPart()}$RESET_PIN_SUFFIX") {
            bearer(); jsonBody(ResetPinRequest.serializer(), ResetPinRequest(pin))
        }
        mapSettingsResponse(log, resp) { }
    }

    // ── Secrets ──

    open suspend fun getSecretsStatus(): AuthResult<SecretsStatus> = safeSettingsCall(log) {
        log.debug("getSecretsStatus")
        val resp = httpClient.get("$baseUrl$PATH_SECRETS") { bearer() }
        mapSettingsResponse(log, resp) { it.body<SecretsStatus>() }
    }

    /**
     * PUT /admin/secrets/llm/{provider}. Pass value/baseUrl to set; "" to clear;
     * null to leave untouched. Key material NEVER logged.
     */
    open suspend fun setLlmProviderKey(
        provider: String,
        value: String? = null,
        providerBaseUrl: String? = null,
    ): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("setLlmProviderKey", mapOf("provider" to provider, "hasKey" to (value != null)))
        val resp = httpClient.put("$baseUrl$PATH_SECRETS_LLM/${provider.encodeURLPathPart()}") {
            bearer()
            jsonBody(LlmKeyPatchRequest.serializer(), LlmKeyPatchRequest(value = value, baseUrl = providerBaseUrl))
        }
        mapSettingsResponse(log, resp) { }
    }

    open suspend fun setActiveLlmProvider(provider: String): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("setActiveLlmProvider", mapOf("provider" to provider))
        val resp = httpClient.put("$baseUrl$PATH_SECRETS_LLM_ACTIVE") {
            bearer(); jsonBody(ActiveProviderRequest.serializer(), ActiveProviderRequest(provider))
        }
        mapSettingsResponse(log, resp) { }
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }

    private fun <T> HttpRequestBuilder.jsonBody(serializer: KSerializer<T>, value: T) {
        contentType(ContentType.Application.Json)
        setBody(settingsBodyJson.encodeToString(serializer, value))
    }
}
