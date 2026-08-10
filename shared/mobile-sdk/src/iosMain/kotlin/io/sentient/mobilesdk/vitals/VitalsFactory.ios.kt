// ---------------------------------------------------------------------------
// VitalsFactory.ios — Swift/SKIE-friendly construction of the vitals pieces that
// a Swift caller cannot build directly: the Ktor-backed VitalsUploader, the
// app-lifetime CoroutineScope, and the stable device id.
//
// The VitalsUploader takes an INJECTED HttpClient so the platform owns the engine
// + TLS policy. On iOS we supply Ktor's Darwin engine with the SAME JSON
// ContentNegotiation + debug self-signed TLS bypass the AuthClient / SessionsHttpClient
// factories use — so the dev-TLS posture is consistent and never duplicated by Swift.
//
// Mirrors createAuthClient / createSessionsHttpClient: Swift calls these free
// functions with primitives (a token closure, a URL string, a Boolean) and never
// touches Ktor, a CoroutineScope, or the DeviceIdProvider/store wiring.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.vitals

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.DeviceIdProvider
import io.sentient.mobilesdk.secure.IosDeviceIdStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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

private val log = createLogger("vitals", "factory", "ios")

/**
 * Build the [VitalsUploader] for iOS: a Darwin-backed Ktor [HttpClient] with JSON
 * ContentNegotiation + the debug-only self-signed-dev-host TLS bypass, pointed at
 * the same gateway URL the SDK uses. The Swift app builds this ONLY when the
 * backend resolves configured (else a prior crash auto-uploads on a later launch).
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws` — inbound-proxy's 443,
 *   which is the default and is typically omitted from the URL.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param token Lambda returning the current PASETO session token ("" when absent).
 */
fun createVitalsUploader(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    token: () -> String,
): VitalsUploader {
    log.info(
        "create-uploader",
        mapOf("gatewayWsUrl" to gatewayWsUrl, "allowSelfSignedDevHost" to allowSelfSignedDevHost),
    )
    return VitalsUploader(
        httpClient = buildVitalsHttpClient(allowSelfSignedDevHost),
        gatewayWsUrl = gatewayWsUrl,
        token = token,
    )
}

/**
 * Build the [VitalsConfig] with the commonMain default tunables (ring / file caps,
 * keepFiles, sdkVersion). Kotlin default-parameter values do NOT cross the ObjC/SKIE
 * bridge — a Swift caller would otherwise have to restate every default as a literal
 * (magic numbers). This factory keeps those defaults in ONE place (the Kotlin data
 * class) so Swift passes only the two app-supplied fields.
 *
 * @param appVersion CFBundleShortVersionString.
 * @param build CFBundleVersion.
 */
fun createVitalsConfig(appVersion: String, build: String): VitalsConfig =
    VitalsConfig(appVersion = appVersion, build = build)

/**
 * App-lifetime scope for vitals (never cancelled by the app — it must outlive the
 * connection scope so a prior crash auto-uploads regardless of login state).
 * SupervisorJob so one failed auto-upload never tears the scope down.
 */
fun createVitalsAppScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * The stable per-install device id, resolved from the SAME [DeviceIdProvider] /
 * [IosDeviceIdStore] the SDK uses on connect — so the vitals session-header
 * deviceId matches the gateway's `session.configure` deviceId.
 */
fun createVitalsDeviceId(): String = DeviceIdProvider(IosDeviceIdStore()).getOrCreate()

/**
 * Darwin engine + JSON ContentNegotiation, with the dev TLS bypass applied only
 * when [allowSelfSignedDevHost] is true.
 *
 * SECURITY GUARD: handleChallenge is registered ONLY inside the bypass branch.
 * The release path installs no challenge handler — NSURLSession validates the
 * server certificate against the system trust store. Mirrors the Auth / Sessions
 * http-client factories exactly.
 */
private fun buildVitalsHttpClient(allowSelfSignedDevHost: Boolean): HttpClient =
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
