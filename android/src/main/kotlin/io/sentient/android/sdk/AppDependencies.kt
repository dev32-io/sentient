// ---------------------------------------------------------------------------
// AppDependencies — app-lifetime (non-SDK) singletons.
//
// Holds the small set of app-lived dependencies that legitimately outlive a
// chat screen: token store, auth client, and the capability list.
//
// The SDK instance itself lives ONLY inside the User/Connection scope owned by
// [UserSessionManager]. Nothing here creates or holds a SentientSdk.
//
// createPlatformBundle() / MobileSdk.initAndroid(applicationContext) MUST run
// (SentientApp.onCreate) before the first access so the Android Context is
// available for the SecureTokenStore.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.connectors.AssistantAudioResponseConnector
import io.sentient.mobilesdk.connectors.CognitionStatusConnector
import io.sentient.mobilesdk.connectors.ConversationHistoryConnector
import io.sentient.mobilesdk.connectors.InFlightMessageConnector
import io.sentient.mobilesdk.connectors.PreferencesConnector
import io.sentient.mobilesdk.connectors.SessionsConnector
import io.sentient.mobilesdk.connectors.TaskListConnector
import io.sentient.mobilesdk.connectors.UserAudioInputConnector
import io.sentient.mobilesdk.connectors.UserTextInputConnector
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend

object AppDependencies {
    private val log = createLogger("android", "app-dependencies")

    /**
     * Full connector capability set advertised in `session.configure`, mirroring
     * the webui set. Every value is a connector's published `CAPABILITY` const.
     */
    val capabilities: List<String> = listOf(
        UserTextInputConnector.CAPABILITY,
        UserAudioInputConnector.CAPABILITY,
        AssistantAudioResponseConnector.CAPABILITY,
        ConversationHistoryConnector.CAPABILITY,
        InFlightMessageConnector.CAPABILITY,
        CognitionStatusConnector.CAPABILITY,
        PreferencesConnector.CAPABILITY,
        TaskListConnector.CAPABILITY,
        SessionsConnector.CAPABILITY,
    )

    /**
     * The SecureTokenStore the SDK reads its handshake token from. The login
     * flow saves the token here on success; [SentientSdk.connect] reads it. Built
     * from the platform bundle (same instance UserSessionManager's SDK uses).
     */
    val tokenStore: SecureTokenStore by lazy {
        createPlatformBundle().tokenStore
    }

    @Volatile
    private var authClientInstance: AuthClient? = null

    /**
     * REST AuthClient for listUsers/login. Built lazily from the resolved backend's
     * gateway WS URL + an OkHttp HttpClient with the debug-only self-signed TLS bypass.
     * Rebuilt on next access if the backend config changes (authClientInstance nulled).
     */
    val authClient: AuthClient
        get() = authClientInstance ?: synchronized(this) {
            authClientInstance ?: buildAuthClient().also { authClientInstance = it }
        }

    /** Invalidate the cached AuthClient so the next access rebuilds from the current config. */
    fun invalidateAuthClient() {
        authClientInstance = null
    }

    private fun buildAuthClient(): AuthClient {
        val r = resolveBackend(
            override = BackendConfigHolder.store.config.value,
            buildTimeDefaultUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
            buildTimeAllowSelfSigned = io.sentient.android.BuildConfig.DEBUG,
        )
        require(r is ResolvedBackend.Configured) { "AuthClient accessed while backend unconfigured" }
        log.info("build-auth-client", mapOf("gatewayWsUrl" to r.gatewayWsUrl))
        return AuthClient(
            gatewayWsUrl = r.gatewayWsUrl,
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
        )
    }
}
