// ---------------------------------------------------------------------------
// VitalsHolder — app-lifetime owner of the single SentientMobileVitals instance.
//
// One process-wide diagnostic facade, initialised ONCE in SentientApp.onCreate and
// reused at every call site (background flush, Settings list/upload). Holding it
// here (not in a Koin scope) is deliberate: vitals must capture crashes from the
// EARLIEST point — before login, before any connection scope — and must survive
// logout→login.
//
// Init strategy (per Task 11 §2 — correctness of crash capture over auto-upload
// immediacy): the file/ring/crash parts come up unconditionally at app start so a
// crash is captured from launch. The uploader is built ONLY when a backend is
// already configured (resolveBackend → Configured); if the backend is still
// unconfigured at first launch the uploader is null and a prior crash simply
// auto-uploads on the next launch where a backend + token exist.
//
// deviceId is resolved from the SAME DeviceIdProvider the SDK uses, so the vitals
// session header's deviceId matches the gateway's session.configure deviceId.
// userId is NOT readily available at app start (login userId is transient; the
// persisted token is opaque PASETO), so it is passed null per the task.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import android.content.Context
import io.sentient.android.BuildConfig
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.secure.DeviceIdProvider
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.vitals.AndroidVitalsPlatform
import io.sentient.mobilesdk.vitals.SentientMobileVitals
import io.sentient.mobilesdk.vitals.SentientMobileVitalsPlatform
import io.sentient.mobilesdk.vitals.VitalsConfig
import io.sentient.mobilesdk.vitals.VitalsSessionInfo
import io.sentient.mobilesdk.vitals.VitalsUploader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * App-lifetime holder for the single [SentientMobileVitals] facade. [init] runs once
 * from SentientApp.onCreate; everything else reads the already-built instance.
 */
object VitalsHolder {
    private val log = createLogger("android", "vitals-holder")

    /** Process-wide diagnostic facade. The same instance at init / background / Settings. */
    val vitals = SentientMobileVitals()

    // App-scoped, never cancelled — vitals (incl. auto-upload of a prior crash) lives for
    // the whole process, independent of the connection scope torn down on logout.
    private val appScope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Held so the ViewModel can read a chosen session's body for upload without
    // re-resolving platform/file plumbing. Same platform instance vitals writes through.
    private var platform: SentientMobileVitalsPlatform? = null

    /**
     * One-shot init. Crash capture + file rotation come up unconditionally; the uploader
     * is built only if a backend is already configured. Safe to call before login.
     */
    fun init(appContext: Context) {
        val vitalsPlatform = AndroidVitalsPlatform(appContext)
        platform = vitalsPlatform

        // Same DeviceIdProvider/store the SDK uses → the vitals deviceId matches the
        // gateway session.configure deviceId. createPlatformBundle() requires the
        // Android Context, which MobileSdk.initAndroid has already populated.
        val bundle = createPlatformBundle()
        val deviceId = DeviceIdProvider(bundle.deviceIdStore).getOrCreate()

        // Uploader is best-effort: only when the backend resolves Configured. Built the
        // SAME way SessionsHttpClient is (UserSessionManager.buildSdk): the auth OkHttp
        // engine + the resolved gateway WS URL + a token supplier off the same token store.
        val uploader = buildUploaderOrNull(bundle.tokenStore::load)

        vitals.init(
            config = VitalsConfig(
                appVersion = BuildConfig.VERSION_NAME,
                build = BuildConfig.VERSION_CODE.toString(),
            ),
            platform = vitalsPlatform,
            deviceId = deviceId,
            userId = null, // not available at app start; see file header.
            nowMs = System.currentTimeMillis(),
            network = currentNetwork(appContext),
            uploader = uploader,
            scope = appScope,
        )
        log.info("init", mapOf("uploader" to (uploader != null), "deviceId.len" to deviceId.length))
    }

    fun onAppBackground() = vitals.onAppBackground()

    fun sessions(): List<VitalsSessionInfo> = vitals.listSessions()

    /** Read a chosen session's file body for upload. Null if missing/unreadable. */
    fun readSessionBody(path: String): String? = platform?.readFile(path)

    private fun buildUploaderOrNull(token: () -> String?): VitalsUploader? {
        val r = resolveBackend(
            override = BackendConfigHolder.store.config.value,
            buildTimeDefaultUrl = BuildConfig.GATEWAY_WS_URL,
            buildTimeAllowSelfSigned = BuildConfig.DEBUG,
        )
        if (r !is ResolvedBackend.Configured) {
            log.info("uploader.skip", mapOf("reason" to "backend-unconfigured"))
            return null
        }
        return VitalsUploader(
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
            gatewayWsUrl = r.gatewayWsUrl,
            token = { token() ?: "" },
        )
    }
}
