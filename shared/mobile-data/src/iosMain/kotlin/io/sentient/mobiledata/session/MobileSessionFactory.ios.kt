// ---------------------------------------------------------------------------
// MobileSessionFactory.ios — Swift-friendly one-call MobileSession construction.
//
// createMobileSession() is the iOS entry point (SKIE-exposed to Swift). It
// mirrors createSentientSdk() in mobile-sdk's iosMain: same SupervisorJob +
// Dispatchers.Default.limitedParallelism(1) scope, same createPlatformBundle()
// call, same SdkConfig shape. The difference is that MobileSession needs the
// SAME scope the SDK uses (so the connection collector and repositories share
// structured cancellation with the SDK). We own scope construction here and
// pass it to both SentientSdk and MobileSession.
//
// Approach: call createPlatformBundle() directly from iosMain (it is a public
// expect/actual in mobile-sdk, fully visible here via the api() dependency).
// No changes to mobile-sdk visibility were needed.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.session

import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Build a [MobileSession] for iOS, wiring the iOS platform bundle, a
 * per-session coroutine scope, and the [SdkConfig] internally.
 *
 * The scope is SupervisorJob on Dispatchers.Default.limitedParallelism(1) —
 * matching the Android SdkSessionFactory scope and mobile-sdk's createSentientSdk
 * scope style: one active SDK coroutine at a time, removing transport/pipeline
 * thread-safety races.
 *
 * SKIE exposes this to Swift as a regular free function with primitive parameters.
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Extra capability strings; merged with the connector set.
 */
/**
 * @param devFaultsEnabled True in debug builds to enable [FaultHooks]. Pass
 *   `#if DEBUG true #else false #endif` from Swift; defaults false for release.
 */
fun createMobileSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
): MobileSession {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))
    val config = SdkConfig(
        gatewayWsUrl = gatewayWsUrl,
        allowSelfSignedDevHost = allowSelfSignedDevHost,
        capabilities = capabilities,
        devFaultsEnabled = devFaultsEnabled,
    )
    val bundle = createPlatformBundle()
    val sdk = SentientSdk(config = config, bundle = bundle, scope = scope)
    return MobileSession(sdk = sdk, scope = scope)
}
