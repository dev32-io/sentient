// ---------------------------------------------------------------------------
// UpdateCheckerFactory.ios — Swift/SKIE-friendly construction of the OTA
// [UpdateChecker] for iOS.
//
// The commonMain [UpdateChecker] takes an INJECTED HttpClient so the platform
// owns the engine + TLS policy. A Swift caller cannot ergonomically build a Ktor
// HttpClient or a handleChallenge lambda (see AuthClientFactory.ios.kt), so this
// factory keeps that construction inside the SDK — exactly mirroring
// createAuthClient / createSessionsHttpClient. Swift calls createUpdateChecker(...)
// with primitives; the returned UpdateChecker.check() bridges to Swift async.
//
// The manifest fetch is an UNAUTHENTICATED GET of /download/manifest.json on the
// gateway root ([deriveHostRoot] strips the WS path), so it is fully independent
// of the WS connect path — which is why the UI can run a cheap cold-start check
// at launch to drive the force-update gate.
//
// SECURITY: the trust-all challenge handler is registered ONLY inside the
// `if (allowSelfSignedDevHost)` branch (debug self-signed dev host, e.g.
// https://localhost). The release path (false) installs no handleChallenge, so
// NSURLSession performs standard system certificate validation. Mirrors the WS
// engine + Auth/Sessions HTTP client policy.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.update

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

private val log = createLogger("update", "checker-factory", "ios")

/**
 * Build the OTA [UpdateChecker] for iOS: a Darwin-backed Ktor [HttpClient] with
 * JSON ContentNegotiation (ignoreUnknownKeys so newer manifest fields decode
 * cleanly) + the debug-only self-signed-dev-host TLS bypass, constructed from the
 * same gateway URL as the SDK. [deriveHostRoot] maps the WS URL to the gateway
 * root the `/download/manifest.json` GET hangs off.
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://localhost:8888/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param installedBuild The running build number (iOS CFBundleVersion).
 * @param installedVersionName The running marketing version (CFBundleShortVersionString).
 */
fun createUpdateChecker(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    installedBuild: Int,
    installedVersionName: String,
): UpdateChecker {
    val hostRoot = deriveHostRoot(gatewayWsUrl)
    log.info(
        "create",
        mapOf("host" to hostRoot, "installedBuild" to installedBuild),
    )
    return UpdateChecker(
        hostRootUrl = hostRoot,
        httpClient = buildUpdateHttpClient(allowSelfSignedDevHost),
        platform = UpdatePlatform.IOS,
        installed = InstalledVersion(installedBuild, installedVersionName),
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
private fun buildUpdateHttpClient(allowSelfSignedDevHost: Boolean): HttpClient =
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
