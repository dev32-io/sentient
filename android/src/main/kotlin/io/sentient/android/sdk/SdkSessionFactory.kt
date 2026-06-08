// ---------------------------------------------------------------------------
// SdkSessionFactory — chat-scoped SDK session factory.
//
// Builds a SentientSdk + CoroutineScope, then delegates ALL repository wiring
// and lifecycle (open/close/pause/resume) to the shared MobileSession in
// shared/mobile-data. This keeps the wiring in one place for both Android and iOS.
//
// The SDK instance exists ONLY here — there is no process-wide SDK singleton.
// App-lifetime non-SDK deps (tokenStore, authClient, capabilities) live in
// AppDependencies.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.mobiledata.session.MobileSession
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Factory for [MobileSession]. Each call produces a new scope-isolated session;
 * no state is shared between calls.
 *
 * Requirements:
 *  - [MobileSdk.initAndroid] MUST have been called (Application.onCreate) before
 *    the first [create] — createPlatformBundle() reads the Android Context from
 *    AndroidContextHolder.
 *  - A configured backend MUST be available (resolve returns [ResolvedBackend.Configured]).
 */
object SdkSessionFactory {
    fun create(): MobileSession {
        // Per-session scope: SupervisorJob so one failing child loop never cancels
        // the SDK's other coroutines. limitedParallelism(1) — connectors + AudioPipeline
        // assume single-threaded access.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

        val r = resolveBackend(
            override = BackendConfigHolder.store.config.value,
            buildTimeDefaultUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
            buildTimeAllowSelfSigned = io.sentient.android.BuildConfig.DEBUG,
        )
        require(r is ResolvedBackend.Configured) {
            "SdkSessionFactory.create() called while backend unconfigured"
        }

        val config = SdkConfig(
            gatewayWsUrl = r.gatewayWsUrl,
            allowSelfSignedDevHost = r.allowSelfSignedDevHost,
            capabilities = AppDependencies.capabilities,
            devFaultsEnabled = io.sentient.android.BuildConfig.DEBUG,
        )

        // createPlatformBundle() resolves the Android Context via AndroidContextHolder;
        // a fresh instance per session so each session owns its own adapters.
        val bundle = createPlatformBundle()

        val sdk = SentientSdk(config = config, bundle = bundle, scope = scope)

        return MobileSession(
            sdk = sdk,
            scope = scope,
            clock = Clock { System.currentTimeMillis() },
        )
    }
}
