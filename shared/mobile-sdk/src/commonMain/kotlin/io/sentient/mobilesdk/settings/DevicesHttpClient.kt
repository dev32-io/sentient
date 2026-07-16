// ---------------------------------------------------------------------------
// DevicesHttpClient — REST client for the Signal device-linking surface
// (gateway/src/api/handlers/devices.ts).
//
//   getDevices        GET  /devices                    → {platforms:{signal}}
//   signalLinkStart   POST /devices/signal/link        → {qrDataUrl, expiresAt}
//   signalLinkCancel  POST /devices/signal/link/cancel → {ok:true}
//   signalLinkStatus  GET  /devices/signal/link/status → {state, account_masked?, error?}
//   signalUnlink      POST /devices/signal/unlink      → {status:"unlinked"}
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.http.HttpHeaders
import io.sentient.mobilesdk.auth.AuthResult
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger

private const val PATH_DEVICES = "/devices"
private const val PATH_SIGNAL_LINK = "/devices/signal/link"
private const val PATH_SIGNAL_LINK_CANCEL = "/devices/signal/link/cancel"
private const val PATH_SIGNAL_LINK_STATUS = "/devices/signal/link/status"
private const val PATH_SIGNAL_UNLINK = "/devices/signal/unlink"

/** REST client for `/api/v1/devices*`. */
open class DevicesHttpClient(
    private val httpClient: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("settings", "devices-http")

    open suspend fun getDevices(): AuthResult<DevicesResponse> = safeSettingsCall(log) {
        log.debug("getDevices")
        val resp = httpClient.get("$baseUrl$PATH_DEVICES") { bearer() }
        mapSettingsResponse(log, resp) { it.body<DevicesResponse>() }
    }

    open suspend fun signalLinkStart(): AuthResult<SignalLinkStartResponse> = safeSettingsCall(log) {
        log.info("signalLinkStart")
        val resp = httpClient.post("$baseUrl$PATH_SIGNAL_LINK") { bearer() }
        mapSettingsResponse(log, resp) { it.body<SignalLinkStartResponse>() }
    }

    open suspend fun signalLinkCancel(): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("signalLinkCancel")
        val resp = httpClient.post("$baseUrl$PATH_SIGNAL_LINK_CANCEL") { bearer() }
        mapSettingsResponse(log, resp) { }
    }

    open suspend fun signalLinkStatus(): AuthResult<SignalLinkStatusResponse> = safeSettingsCall(log) {
        log.debug("signalLinkStatus")
        val resp = httpClient.get("$baseUrl$PATH_SIGNAL_LINK_STATUS") { bearer() }
        mapSettingsResponse(log, resp) { it.body<SignalLinkStatusResponse>() }
    }

    open suspend fun signalUnlink(): AuthResult<Unit> = safeSettingsCall(log) {
        log.info("signalUnlink")
        val resp = httpClient.post("$baseUrl$PATH_SIGNAL_UNLINK") { bearer() }
        mapSettingsResponse(log, resp) { }
    }

    private fun HttpRequestBuilder.bearer() {
        header(HttpHeaders.Authorization, "Bearer ${token()}")
    }
}
