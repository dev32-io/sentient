// ---------------------------------------------------------------------------
// IosUserSession — the User/Connection scope for iOS (SKIE-exposed to Swift).
//
// Mirrors the Android UserSessionManager: models the "logged-in user" by owning
// ONE ChatComponent (+ its SentientSdk + a session CoroutineScope), built once
// for the duration of a login. Switching conversation is a NAVIGATION that
// recreates the chat ViewModel (NOT a new SDK) — the SDK + socket live ABOVE the
// SwiftUI NavigationStack so history / settings / conversation-switch never drop it.
//
// Lifecycle:
//   - open()   — background connect(); the UI never blocks on it.
//   - pause()  — app background: drop the socket but stay in session (clearSession=false).
//   - resume() — app foreground: re-arm reconnect.
//   - close()  — logout: disconnect(clearSession=true) + cancel the scope.
//
// Construction mirrors MobileSessionFactory.ios.kt: a SupervisorJob +
// Dispatchers.Default.limitedParallelism(1) scope shared by the SDK and the
// ChatComponent's repositories, so transport / pipeline run single-threaded with
// no cross-coroutine races.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.di

import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * One per logged-in user. Holds the SDK + ChatComponent + the session scope; the
 * Swift `UserSession` ObservableObject wraps an instance of this and exposes
 * `component` to the chat / history ViewModels.
 *
 * @param gatewayWsUrl Full WS URL, e.g. `wss://host/api/v1/ws`.
 * @param allowSelfSignedDevHost Debug-only TLS bypass. MUST be false in release.
 * @param capabilities Extra capability strings; merged with the connector set.
 * @param devFaultsEnabled True in debug builds to enable FaultHooks.
 */
class IosUserSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
) {
    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

    private val sdk: SentientSdk = SentientSdk(
        config = SdkConfig(
            gatewayWsUrl = gatewayWsUrl,
            allowSelfSignedDevHost = allowSelfSignedDevHost,
            capabilities = capabilities,
            devFaultsEnabled = devFaultsEnabled,
        ),
        bundle = createPlatformBundle(),
        scope = scope,
    )

    /** The single ChatComponent for this login — usecases + connection + passthroughs. */
    val component: ChatComponent = ChatComponent(sdk)

    /** Background connect: UI is usable immediately; reconnect is owned by the SDK. */
    fun open() {
        scope.launch { sdk.connect() }
    }

    /** App background → drop the socket but stay in session (clearSession=false). */
    fun pause() {
        sdk.disconnect(clearSession = false)
    }

    /** App foreground → re-arm reconnect on the live SDK. Idempotent. */
    fun resume() {
        sdk.forceReconnect()
    }

    /** Logout teardown: disconnect (clearSession=true) + cancel the session scope. */
    fun close() {
        sdk.disconnect(clearSession = true)
        scope.cancel()
    }
}

/**
 * Build an [IosUserSession] for iOS. SKIE exposes this to Swift as a free function
 * with primitive parameters — the Swift `UserSession` calls it from the resolved
 * backend (gateway URL + dev-TLS posture + capabilities).
 */
fun createUserSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
): IosUserSession = IosUserSession(
    gatewayWsUrl = gatewayWsUrl,
    allowSelfSignedDevHost = allowSelfSignedDevHost,
    capabilities = capabilities,
    devFaultsEnabled = devFaultsEnabled,
)
