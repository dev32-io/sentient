// ---------------------------------------------------------------------------
// AuthClientFactory.ios — Swift-friendly construction of the REST [AuthClient]
// and the Keychain token store for iOS.
//
// The commonMain [AuthClient] takes an INJECTED HttpClient so the platform owns
// the engine + TLS policy. On iOS we supply Ktor's Darwin engine with JSON
// ContentNegotiation and, in DEBUG only, the same self-signed dev-host TLS
// bypass IosWebSocketEngine uses for wss://localhost — a handleChallenge that
// trusts server-trust challenges unconditionally. The flag is supplied by the
// Swift app from #if DEBUG; it is NEVER hardcoded true here.
//
// SECURITY: the trust-all challenge handler is registered ONLY inside the
// `if (allowSelfSignedDevHost)` branch. The release path (false) installs no
// handleChallenge, so NSURLSession performs standard system certificate
// validation. Mirrors the WS engine's policy + the Android AuthHttpClient.
//
// The Kotlin defaults on AuthClient's `log` and the Darwin client config are
// lost across the ObjC/SKIE bridge, and a Swift caller cannot ergonomically
// build a Ktor HttpClient or a handleChallenge lambda — so this factory keeps
// that construction inside the SDK, mirroring createSentientSdk / the existing
// createPlatformBundle helper. Swift calls createAuthClient(...) with primitives.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.IosSecureTokenStore
import io.sentient.mobilesdk.secure.SecureTokenStore
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

private val log = createLogger("auth", "factory", "ios")

/**
 * Build the REST [AuthClient] for iOS: a Darwin-backed Ktor [HttpClient] with
 * JSON ContentNegotiation (ignoreUnknownKeys so newer gateway fields decode
 * cleanly) + the debug-only self-signed-dev-host TLS bypass, constructed from
 * the same gateway URL as the SDK. [deriveBaseUrl] (inside AuthClient) maps the
 * WS URL to the REST base.
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://localhost:8888/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 */
fun createAuthClient(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
): AuthClient {
    log.info(
        "create",
        mapOf("gatewayWsUrl" to gatewayWsUrl, "allowSelfSignedDevHost" to allowSelfSignedDevHost),
    )
    return AuthClient(
        gatewayWsUrl = gatewayWsUrl,
        httpClient = buildAuthHttpClient(allowSelfSignedDevHost),
    )
}

/**
 * The same Keychain-backed [SecureTokenStore] the SDK reads its handshake token
 * from. The login flow saves the token here on success; [createSentientSdk]'s
 * bundle reads the identical Keychain item (fixed service/account) on connect.
 *
 * IosSecureTokenStore holds no mutable state — it reads/writes one fixed
 * Keychain entry — so this instance and the SDK bundle's instance share storage.
 */
fun createTokenStore(): SecureTokenStore = IosSecureTokenStore()

/**
 * Darwin engine + JSON ContentNegotiation, with the dev TLS bypass applied only
 * when [allowSelfSignedDevHost] is true.
 *
 * SECURITY GUARD: handleChallenge is registered ONLY inside the bypass branch.
 * The release path installs no challenge handler — NSURLSession validates the
 * server certificate against the system trust store.
 *
 */
private fun buildAuthHttpClient(allowSelfSignedDevHost: Boolean): HttpClient =
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
