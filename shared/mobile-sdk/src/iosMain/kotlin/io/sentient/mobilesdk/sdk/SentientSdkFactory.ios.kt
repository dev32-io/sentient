// ---------------------------------------------------------------------------
// SentientSdkFactory.ios — Swift-friendly one-call SDK construction for iOS.
//
// The SentientSdk constructor needs a CoroutineScope, an id generator, a
// suspend delay fn, and the idle/sessions timing longs. Kotlin gives all but
// scope a default; across the ObjC/SKIE bridge those defaults are LOST, and a
// Swift caller cannot ergonomically build a CoroutineScope or a
// KotlinSuspendFunction1. This factory keeps that construction inside the SDK
// — mirroring the existing createPlatformBundle() iOS helper — so the iOS app
// builds the SDK with a single typed call and supplies only its SdkConfig.
//
// The scope is an app-lifetime SupervisorJob on the default dispatcher (one
// failing child loop never cancels the SDK's other coroutines), matching the
// Android SdkHolder scope. The process owns the one SDK instance for its
// lifetime, so the scope is intentionally never cancelled here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Build the one [SentientSdk] for iOS, wiring the platform bundle, an
 * app-lifetime coroutine scope, and the [SdkConfig] internally.
 *
 * The config is assembled here from primitives because the Kotlin defaults on
 * [SdkConfig.reconnect] and [ReconnectConfig] are LOST across the ObjC/SKIE
 * bridge — a Swift caller cannot construct a default [ReconnectConfig]. Keeping
 * config assembly in Kotlin preserves those defaults and gives Swift a clean
 * primitive-only entry point.
 *
 * The orchestrator merges each connector's own capability with [capabilities],
 * so the caller may pass an empty list and still advertise every connector in
 * `session.configure` (web-sdk / Android parity).
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Extra capability strings; merged with the connector set.
 */
fun createSentientSdk(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    capabilities: List<String> = emptyList(),
): SentientSdk = SentientSdk(
    config = SdkConfig(
        gatewayWsUrl = gatewayWsUrl,
        allowSelfSignedDevHost = allowSelfSignedDevHost,
        capabilities = capabilities,
    ),
    bundle = createPlatformBundle(),
    scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
)
