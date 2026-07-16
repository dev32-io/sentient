// ---------------------------------------------------------------------------
// SettingsHttpClientFactory.ios — Swift/SKIE-friendly construction of the raw
// Ktor [HttpClient] the settings connection scope (SettingsComponent) builds its
// REST clients over.
//
// Unlike createSessionsHttpClient (which returns a wrapped SessionsHttpClient),
// this returns the RAW HttpClient because SettingsComponent's constructor injects
// one HttpClient and builds every settings client (Profile / Voices / Providers /
// Devices / Admin / Auth) over it internally.
//
// GENEROUS request timeout: the apply / soul / memory / personality writes BLOCK
// multi-seconds through a Hermes worker restart, and the settings clients set no
// per-request timeout. Without a generous policy here the Darwin engine's ~60s
// request default would resolve a healthy slow restart as a network failure — so
// this installs HttpTimeout at [SETTINGS_REQUEST_TIMEOUT_MS] (~120s).
//
// Mirrors createSessionsHttpClient / createVitalsUploader: same Darwin engine,
// same JSON ContentNegotiation, and the SAME debug-only self-signed TLS bypass
// (with the identical security guard — the handler is registered ONLY inside the
// bypass branch; the release path validates against the system trust store).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.log.createLogger
import kotlinx.serialization.json.Json
import platform.Foundation.NSURLAuthenticationChallenge
import platform.Foundation.NSURLAuthenticationMethodServerTrust
import platform.Foundation.NSURLCredential
import platform.Foundation.NSURLSession
import platform.Foundation.NSURLSessionAuthChallengeDisposition
import platform.Foundation.NSURLSessionAuthChallengePerformDefaultHandling
import platform.Foundation.NSURLSessionAuthChallengeUseCredential
import platform.Foundation.NSURLSessionTask
import platform.Foundation.credentialForTrust
import platform.Foundation.serverTrust
import platform.Security.SecTrustRef

@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

private val log = createLogger("settings", "http-client-factory", "ios")

/** Generous request timeout (ms) covering the restart-blocking apply/soul/memory writes. */
private const val SETTINGS_REQUEST_TIMEOUT_MS = 120_000L

/**
 * Build the raw settings [HttpClient] for iOS: a Darwin-backed Ktor client with
 * JSON ContentNegotiation, a generous [HttpTimeout], and — in DEBUG only — the
 * same self-signed dev-host TLS bypass used by the sessions / auth clients.
 *
 * [IosUserSession] passes the result into [io.sentient.mobiledata.di.SettingsComponent]
 * as its single injected HttpClient.
 *
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 */
@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
fun createSettingsHttpClient(allowSelfSignedDevHost: Boolean): HttpClient {
    log.info("create", mapOf("allowSelfSignedDevHost" to allowSelfSignedDevHost))
    return HttpClient(Darwin) {
        engine {
            if (allowSelfSignedDevHost) {
                log.warn(
                    "DEV-ONLY: TLS certificate validation disabled — self-signed cert trusted",
                    mapOf("guard" to "allowSelfSignedDevHost=true"),
                )
                handleChallenge { _: NSURLSession,
                                  _: NSURLSessionTask,
                                  challenge: NSURLAuthenticationChallenge,
                                  completionHandler: (NSURLSessionAuthChallengeDisposition, NSURLCredential?) -> Unit ->
                    if (challenge.protectionSpace.authenticationMethod ==
                        NSURLAuthenticationMethodServerTrust
                    ) {
                        val trust: SecTrustRef? = challenge.protectionSpace.serverTrust
                        val credential: NSURLCredential? =
                            if (trust != null) NSURLCredential.credentialForTrust(trust) else null
                        completionHandler(NSURLSessionAuthChallengeUseCredential, credential)
                    } else {
                        completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, null)
                    }
                }
            }
        }
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        install(HttpTimeout) { requestTimeoutMillis = SETTINGS_REQUEST_TIMEOUT_MS }
    }
}
