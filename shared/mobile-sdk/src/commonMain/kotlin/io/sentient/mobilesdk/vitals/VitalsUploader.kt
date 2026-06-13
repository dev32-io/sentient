// ---------------------------------------------------------------------------
// VitalsUploader — authenticated POST of a vitals log file to the gateway.
//
// Mirrors SessionsHttpClient conventions:
//   - HttpClient injected by caller (platform engine: OkHttp / Darwin).
//   - Gateway WS URL derived to HTTP base via auth.deriveBaseUrl.
//   - PASETO bearer token supplied by () -> String provider.
//   - Never throws from business logic; returns null on any failure.
//
// Endpoint: POST /api/v1/diagnostics/logs
// Header:   X-Vitals-File: <fileName>
// Progress: Ktor onUpload (bytesSent: Long, contentLength: Long?)
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.vitals

import io.ktor.client.HttpClient
import io.ktor.client.plugins.onUpload
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.createLogger

private const val PATH_DIAGNOSTICS_LOGS = "/api/v1/diagnostics/logs"
private const val HEADER_VITALS_FILE = "X-Vitals-File"
private const val PREVIEW_LEN = 60

/**
 * Uploads a vitals log file to the gateway diagnostics endpoint.
 *
 * @param http Ktor HttpClient with platform engine (OkHttp / Darwin).
 *   The caller owns the client lifecycle.
 * @param gatewayWsUrl Full WS URL (e.g. `wss://host/api/v1/ws`); the base
 *   REST URL is derived via [deriveBaseUrl].
 * @param token Supplier returning the current PASETO session token.
 *   Called on every request so token rotation is transparent.
 */
class VitalsUploader(
    private val http: HttpClient,
    gatewayWsUrl: String,
    private val token: () -> String,
) {
    private val baseUrl = deriveBaseUrl(gatewayWsUrl)
    private val log = createLogger("vitals", "uploader")

    /**
     * POST the log file body to the diagnostics endpoint.
     *
     * @param fileName Logical file name forwarded in the X-Vitals-File header.
     * @param body Raw log file content as a string.
     * @param onProgress Callback invoked with progress in [0.0, 1.0].
     *   Only called when the content-length is known (> 0).
     * @return Server-assigned ref string on success, or null on failure.
     */
    suspend fun upload(fileName: String, body: String, onProgress: (Double) -> Unit): String? {
        log.debug("upload.start", mapOf("fileName" to fileName, "bytes" to body.length))
        return try {
            val resp = http.post("$baseUrl$PATH_DIAGNOSTICS_LOGS") {
                headers {
                    append(HttpHeaders.Authorization, "Bearer ${token()}")
                    append(HEADER_VITALS_FILE, fileName)
                }
                setBody(body)
                onUpload { bytesSent: Long, contentLength: Long? ->
                    if (contentLength != null && contentLength > 0L) {
                        onProgress(bytesSent.toDouble() / contentLength.toDouble())
                    }
                }
            }
            if (!resp.status.isSuccess()) {
                log.warn("upload.error", mapOf("status" to resp.status.value, "fileName" to fileName))
                return null
            }
            val responseText = resp.bodyAsText()
            val ref = Regex("\"ref\"\\s*:\\s*\"([^\"]+)\"")
                .find(responseText)
                ?.groupValues
                ?.get(1)
            log.info("upload.ok", mapOf("fileName" to fileName, "ref" to (ref ?: "-")))
            ref
        } catch (e: Throwable) {
            log.warn(
                "upload.failed",
                mapOf(
                    "fileName" to fileName,
                    "reason" to (e.message?.take(PREVIEW_LEN) ?: "unknown"),
                ),
            )
            null
        }
    }
}
