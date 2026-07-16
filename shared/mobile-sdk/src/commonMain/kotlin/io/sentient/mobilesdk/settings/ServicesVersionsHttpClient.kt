// ---------------------------------------------------------------------------
// ServicesVersionsHttpClient — GET /api/v1/services/versions
// (gateway/src/api/handlers/services-versions.ts). Mobile reads this once to
// gate the Fish UI on features.fish_browse_enabled and to show version chips.
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

private const val PATH_SERVICES_VERSIONS = "/services/versions"

/** REST client for the services/versions feature-flag + version endpoint. */
open class ServicesVersionsHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "services-versions-http")

    /** GET /services/versions → {gateway, hermes, stt_service, tts_service, features}. */
    open suspend fun get(): AuthResult<ServicesVersions> = safeSettingsCall(log) {
        log.debug("get")
        val resp = httpClient.get("$baseUrl$PATH_SERVICES_VERSIONS") {
            header(HttpHeaders.Authorization, "Bearer ${token()}")
        }
        mapSettingsResponse(log, resp) { it.body<ServicesVersions>() }
    }
}
