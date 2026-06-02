// ---------------------------------------------------------------------------
// SdkHolder — process singleton that owns the one SentientSdk instance.
//
// The SDK is a black box: this holder builds it ONCE (lazily, on first access)
// from the platform bundle + an app-lifetime coroutine scope, and hands the
// same instance to every SdkViewModel. The SDK's connect()/disconnect() are
// re-entrant and re-arm the reconnect controller, so a single instance survives
// logout→login without a rebuild.
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Holds the single process-wide [SentientSdk]. Build is lazy + thread-safe; the
 * first caller (the first SdkViewModel) triggers construction.
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
    // the SDK's other coroutines. Default dispatcher — the SDK picks IO/Main at its
    // own boundaries. Never cancelled (process singleton, lives until process death).
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

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

    /** Lazily-built singleton SDK. Requires MobileSdk.initAndroid() to have run. */
    val sdk: SentientSdk
        get() = instance ?: synchronized(this) {
            instance ?: build().also { instance = it }
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

    private fun config(): SdkConfig = SdkConfig(
        // 10.0.2.2 = host loopback from the emulator; see android/build.gradle.kts.
        gatewayWsUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
        // Self-signed dev cert is trusted only in debug builds.
        allowSelfSignedDevHost = io.sentient.android.BuildConfig.DEBUG,
        capabilities = capabilities,
    )

    private fun build(): SentientSdk {
        val config = config()
        log.info(
            "build",
            mapOf(
                "gatewayWsUrl" to config.gatewayWsUrl,
                "allowSelfSignedDevHost" to config.allowSelfSignedDevHost,
                "capabilities" to capabilities.size,
            ),
        )
        return SentientSdk(config = config, bundle = bundle, scope = scope)
    }

    private fun buildAuthClient(): AuthClient {
        val config = config()
        log.info("build-auth-client", mapOf("gatewayWsUrl" to config.gatewayWsUrl))
        return AuthClient(
            gatewayWsUrl = config.gatewayWsUrl,
            httpClient = buildAuthHttpClient(config.allowSelfSignedDevHost),
        )
    }
}
