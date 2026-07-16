// ---------------------------------------------------------------------------
// ProvidersHttpClient — GET /api/v1/providers/models (the LLM model catalog).
// Wire source: gateway/src/api/handlers/providers.ts respondModels.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger

private const val PATH_MODELS = "/providers/models"

/** REST client for the provider model catalog. */
open class ProvidersHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "providers-http")

    /** GET /providers/models → {models, stale}. 503 upstream-unavailable → Server(503). */
    open suspend fun listModels(): AuthResult<ModelCatalog> = safeSettingsCall(log) {
        log.debug("listModels")
        val resp = httpClient.get("$baseUrl$PATH_MODELS") {
            header(HttpHeaders.Authorization, "Bearer ${token()}")
        }
        mapSettingsResponse(log, resp) { it.body<ModelCatalog>() }
    }
}
