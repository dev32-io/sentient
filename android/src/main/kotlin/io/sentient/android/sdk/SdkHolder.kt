// ---------------------------------------------------------------------------
// SdkHolder — process singleton that owns the one SentientSdk instance.
//
// The SDK is built lazily (or eagerly via ensureBuilt) from the resolved
// backend config. applyResolvedConfig() tears down the current instance and
// rebuilds from the freshly-resolved config — the rebuilt SDK starts
// DISCONNECTED, landing the host on the new backend's login.
//
// sdkFlow is the reactive surface: SdkViewModel observes it so a backend
// change re-points the retained ViewModel at the rebuilt instance without
// recreating the Activity/VM.
//
// MobileSdk.initAndroid(applicationContext) MUST run (SentientApp.onCreate)
// before the first [sdk] access — createPlatformBundle() resolves the Android
// Context for the secure stores from the holder set by initAndroid.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.sentient.mobilesdk.connectors.AssistantAudioResponseConnector
import io.sentient.mobilesdk.connectors.CognitionStatusConnector
import io.sentient.mobilesdk.connectors.ConversationHistoryConnector
import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.connectors.PreferencesConnector
import io.sentient.mobilesdk.connectors.SessionsConnector
import io.sentient.mobilesdk.connectors.TaskStatusConnector
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.connectors.UserTextInputConnector
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.PlatformBundle
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds the single process-wide [SentientSdk]. Build is lazy + thread-safe; the
 * first caller (the first SdkViewModel) triggers construction via [ensureBuilt] or
 * direct [sdk] access. A backend change is applied via [applyResolvedConfig].
 */
object SdkHolder {
    private val log = createLogger("android", "sdk-holder")

    /**
     * Full connector capability set advertised in `session.configure`, mirroring
     * the webui set. The orchestrator also merges each connector's own capability,
     * so this is the explicit, SDK-sourced list of what the client supports — no
     * hardcoded strings, every value is a connector's published `CAPABILITY` const.
     */
    val capabilities: List<String> = listOf(
        UserTextInputConnector.CAPABILITY,
        UserAudioInputConnector.CAPABILITY,
        AssistantAudioResponseConnector.CAPABILITY,
        ConversationHistoryConnector.CAPABILITY,
        InFlightMessageConnector.CAPABILITY,
        CognitionStatusConnector.CAPABILITY,
        PreferencesConnector.CAPABILITY,
        TaskStatusConnector.CAPABILITY,
        SessionsConnector.CAPABILITY,
    )

    // App-lifetime scope: a SupervisorJob so one failing child loop never cancels
    // the SDK's other coroutines. Dispatchers.Default is CONFINED to
    // limitedParallelism(1) so at most one SDK coroutine runs at a time — the
    // connectors + AudioPipeline assume single-threaded access (the router drives
    // handle/handleBinary; the pipeline's async start()/frame-buffer share state
    // without locks). A multi-threaded Default raced the downlink first frame
    // against the playback-start coroutine (enqueue-no-track, ~0.33s clip);
    // confinement removes the race while keeping suspension non-blocking. Mirrors
    // web-sdk's single thread + the iOS factory. Never cancelled (process singleton).
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

    @Volatile
    private var instance: SentientSdk? = null

    @Volatile
    private var bundleInstance: PlatformBundle? = null

    @Volatile
    private var authClientInstance: AuthClient? = null

    /** The platform bundle, built once and shared by the SDK + token-store accessor. */
    private val bundle: PlatformBundle
        get() = bundleInstance ?: synchronized(this) {
            bundleInstance ?: createPlatformBundle().also { bundleInstance = it }
        }

    // Reactive SDK surface: null until configured. SdkViewModel observes this so a
    // backend change (applyResolvedConfig) re-points the retained ViewModel at the
    // rebuilt instance without recreating the Activity/VM.
    private val _sdkFlow = MutableStateFlow<SentientSdk?>(null)
    val sdkFlow: StateFlow<SentientSdk?> = _sdkFlow.asStateFlow()

    /** Resolve the active backend from the persisted override + the build-time default. */
    private fun resolved(): ResolvedBackend = resolveBackend(
        override = BackendConfigHolder.store.config.value,
        buildTimeDefaultUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
        buildTimeAllowSelfSigned = io.sentient.android.BuildConfig.DEBUG,
    )

    /** True when a usable backend exists (override or non-empty build default). */
    fun isConfigured(): Boolean = resolved() is ResolvedBackend.Configured

    /** Build the SDK if configured + not yet built. No-op if unconfigured. */
    fun ensureBuilt() {
        if (instance != null) return
        val r = resolved()
        if (r is ResolvedBackend.Configured) synchronized(this) {
            if (instance == null) buildFrom(r)
        }
    }

    /**
     * Apply a newly-saved backend: tear down the current SDK + auth client and
     * rebuild from the freshly-resolved config. The rebuilt SDK starts
     * DISCONNECTED, so the host lands on the new backend's login. Idempotent.
     */
    fun applyResolvedConfig() = synchronized(this) {
        instance?.disconnect()
        authClientInstance = null
        val r = resolved()
        if (r is ResolvedBackend.Configured) buildFrom(r) else { instance = null; _sdkFlow.value = null }
    }

    private fun buildFrom(r: ResolvedBackend.Configured): SentientSdk {
        val config = SdkConfig(
            gatewayWsUrl = r.gatewayWsUrl,
            allowSelfSignedDevHost = r.allowSelfSignedDevHost,
            capabilities = capabilities,
        )
        log.info("build", mapOf(
            "gatewayWsUrl" to config.gatewayWsUrl,
            "allowSelfSignedDevHost" to config.allowSelfSignedDevHost,
            "capabilities" to capabilities.size,
        ))
        return SentientSdk(config = config, bundle = bundle, scope = scope)
            .also { instance = it; _sdkFlow.value = it }
    }

    /** The current SDK. Requires a configured backend + ensureBuilt() first. */
    val sdk: SentientSdk
        get() = instance ?: synchronized(this) {
            instance ?: run {
                val r = resolved()
                require(r is ResolvedBackend.Configured) { "SDK accessed while backend unconfigured" }
                buildFrom(r)
            }
        }

    /**
     * The same SecureTokenStore the SDK reads its handshake token from. The login
     * flow saves the token here on success; [SentientSdk.connect] then reads it.
     */
    val tokenStore: SecureTokenStore
        get() = bundle.tokenStore

    /**
     * REST AuthClient for listUsers/login. Built from the same gateway base URL as
     * the SDK (deriveBaseUrl runs inside AuthClient) + an OkHttp HttpClient with the
     * debug-only self-signed-dev-host TLS bypass, mirroring the WS engine's policy.
     */
    val authClient: AuthClient
        get() = authClientInstance ?: synchronized(this) {
            authClientInstance ?: buildAuthClient().also { authClientInstance = it }
        }

    private fun buildAuthClient(): AuthClient {
        val r = resolved()
        require(r is ResolvedBackend.Configured) { "AuthClient accessed while backend unconfigured" }
        log.info("build-auth-client", mapOf("gatewayWsUrl" to r.gatewayWsUrl))
        return AuthClient(
            gatewayWsUrl = r.gatewayWsUrl,
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
        )
    }
}
