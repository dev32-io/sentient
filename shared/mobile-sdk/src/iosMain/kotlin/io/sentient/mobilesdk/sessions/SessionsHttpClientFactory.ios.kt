// ---------------------------------------------------------------------------
// SessionsHttpClientFactory.ios — Swift/SKIE-friendly construction of the
// REST [SessionsHttpClient] for iOS.
//
// The SessionsHttpClient takes an INJECTED HttpClient so the platform owns the
// engine + TLS policy. On iOS we supply Ktor's Darwin engine with the same
// JSON ContentNegotiation + debug self-signed TLS bypass as the AuthClient.
//
// IosUserSession (mobile-data) calls createSessionsHttpClient() so it never
// duplicates the Darwin engine or TLS-bypass logic.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sessions

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
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

private val log = createLogger("sessions", "http-client-factory", "ios")

/**
 * Build the [SessionsHttpClient] for iOS: a Darwin-backed Ktor [HttpClient]
 * with JSON ContentNegotiation and, in DEBUG only, the same self-signed
 * dev-host TLS bypass used by [AuthClientFactory.ios.kt].
 *
 * [IosUserSession] calls this and passes [token] as a lambda over the shared
 * platform-bundle token store so the SDK and REST client read the same token.
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param token Lambda returning the current PASETO session token.
 */
fun createSessionsHttpClient(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    token: () -> String,
): SessionsHttpClient {
    log.info(
        "create",
        mapOf("gatewayWsUrl" to gatewayWsUrl, "allowSelfSignedDevHost" to allowSelfSignedDevHost),
    )
    return SessionsHttpClient(
        httpClient = buildSessionsHttpClient(allowSelfSignedDevHost),
        gatewayWsUrl = gatewayWsUrl,
        token = token,
    )
}

/**
 * Darwin engine + JSON ContentNegotiation, with the dev TLS bypass applied only
 * when [allowSelfSignedDevHost] is true.
 *
 * SECURITY GUARD: handleChallenge is registered ONLY inside the bypass branch.
 * The release path installs no challenge handler — NSURLSession validates the
 * server certificate against the system trust store.
 */
@OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)
private fun buildSessionsHttpClient(allowSelfSignedDevHost: Boolean): HttpClient =
    HttpClient(Darwin) {
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
    }
