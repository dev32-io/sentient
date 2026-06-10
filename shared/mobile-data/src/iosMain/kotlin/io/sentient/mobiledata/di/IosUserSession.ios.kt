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

import com.russhwolf.settings.NSUserDefaultsSettings
import io.sentient.mobiledata.cache.SyncCursorStore
import io.sentient.mobiledata.cache.SyncCursorStoreResumeAdapter
import io.sentient.mobiledata.cache.db.IosDatabaseDriverFactory
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.sdk.isTerminalAuthError
import io.sentient.mobilesdk.sessions.createSessionsHttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import platform.Foundation.NSUserDefaults

/** NSUserDefaults suite for the durable resume cursor (isolated from other prefs). */
private const val SYNC_CURSOR_SUITE = "sentient_sync_cursor"

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
    private val log = createLogger("data", "ios-user-session")

    // Last-resort guard for an uncaught throw on a connection-scope coroutine.
    // A SupervisorJob does NOT install a handler — without this, an uncaught throw
    // hits Kotlin/Native's global handler and abort()s the process (the iOS SIGABRT
    // this fixes). Classify + route, NEVER rethrow:
    //   - CancellationException → normal teardown, ignore.
    //   - terminal auth         → signalAuthExpired() → ConnectionState.authExpired
    //                             flips → the nav gate routes to login.
    //   - transient             → log + recover; the reconnect supervisor retries.
    // The lambda captures `sdk` but reads it only at throw time (long after `sdk` is
    // constructed), so declaring it BEFORE `scope`/`sdk` is sound — see field order.
    private val exceptionHandler = CoroutineExceptionHandler { _, e ->
        if (e is CancellationException) return@CoroutineExceptionHandler
        if (isTerminalAuthError(e)) {
            log.warn("scope.auth-failure → login", mapOf("error" to (e.message ?: "")))
            sdk.signalAuthExpired()
        } else {
            log.warn("scope.transient-caught (recovered)", mapOf("error" to (e.message ?: "")))
        }
    }

    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1) + exceptionHandler)

    // Build the platform bundle once so the token store is shared between the SDK
    // WS transport and the REST SessionsHttpClient (same Keychain item).
    private val bundle = createPlatformBundle()

    // REST HTTP client for session queries: Darwin engine + same TLS policy as
    // the AuthClient. createSessionsHttpClient (iosMain factory) owns the engine
    // construction so the dev-TLS bypass is consistent and not duplicated.
    private val sessionsHttpClient = createSessionsHttpClient(
        gatewayWsUrl = gatewayWsUrl,
        allowSelfSignedDevHost = allowSelfSignedDevHost,
        token = { bundle.tokenStore.load() ?: "" },
    )

    // Durable resume-cursor backing store: a dedicated NSUserDefaults suite so the
    // cursor keys never collide with other app prefs. Falls back to the standard
    // defaults if the suite can't be opened (e.g. an invalid suite name). Wrapped in
    // the adapter and handed to the SDK so the in-memory cursor survives an app kill
    // (Task 4.7): seed on relaunch, persist on advance, clear on reset/delete.
    private val syncCursorSettings = NSUserDefaultsSettings(openSyncCursorDefaults())
    private val resumeCursorStore = SyncCursorStoreResumeAdapter(SyncCursorStore(syncCursorSettings))

    private val sdk: SentientSdk = SentientSdk(
        config = SdkConfig(
            gatewayWsUrl = gatewayWsUrl,
            allowSelfSignedDevHost = allowSelfSignedDevHost,
            capabilities = capabilities,
            devFaultsEnabled = devFaultsEnabled,
        ),
        bundle = bundle,
        scope = scope,
        sessionsHttpClient = sessionsHttpClient,
        resumeCursorStore = resumeCursorStore,
    )

    /** The single ChatComponent for this login — usecases + connection + passthroughs. */
    val component: ChatComponent = ChatComponent(
        sdk = sdk,
        databaseDriverFactory = IosDatabaseDriverFactory(),
    )

    /**
     * Opens the dedicated NSUserDefaults suite for the sync cursor. If the suite
     * cannot be opened (nil return — invalid or sandbox-restricted suite name), falls
     * back to standardUserDefaults and logs a WARN so the degraded path is visible:
     * cursor keys will live in the standard defaults (collision risk) and will not be
     * scoped to logout.
     */
    @Suppress("ALWAYS_NULL") // Apple docs: init?(suiteName:) returns nil for invalid/restricted names.
    // The KMP binding maps the return as non-null, but the nil-path is real at runtime
    // (e.g. app-group container not entitled). Keep the defensive check + WARN.
    private fun openSyncCursorDefaults(): NSUserDefaults {
        @Suppress("SENSELESS_COMPARISON")
        val suite: NSUserDefaults? = NSUserDefaults(suiteName = SYNC_CURSOR_SUITE)
        if (suite == null) {
            log.warn(
                "sync-cursor-settings.suite-fallback",
                mapOf(
                    "reason" to "suiteName open failed → using standard defaults",
                    "suite" to SYNC_CURSOR_SUITE,
                ),
            )
            return NSUserDefaults.standardUserDefaults
        }
        return suite
    }

    /** Background connect: UI is usable immediately; reconnect is owned by the SDK. */
    fun open() {
        // Belt-and-braces: catch a SYNCHRONOUS throw before the first suspension
        // (the exceptionHandler covers throws after suspension). Same classify +
        // route; rethrow CancellationException to honour structured cancellation.
        scope.launch {
            try {
                sdk.connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (isTerminalAuthError(e)) {
                    log.warn("open.auth-failure → login", mapOf("error" to (e.message ?: "")))
                    sdk.signalAuthExpired()
                } else {
                    log.warn("open.transient-caught (recovered)", mapOf("error" to (e.message ?: "")))
                }
            }
        }
    }

    /**
     * App background → KEEP the socket. The gateway holds the per-user session +
     * ACP wire on WS-detach and has no server ping/timeout, so a brief backgrounding
     * survives on the SAME socket (no reload, no reconnect, no audio teardown). iOS
     * suspends the app anyway; a genuinely dead socket is caught by the foreground
     * probe in [resume]. Intentionally a no-op.
     */
    fun pause() {
        // Do NOT drop the socket on background. See [resume].
    }

    /** App foreground → one-shot liveness probe; reconnect (+ resume session) only if dead. */
    fun resume() {
        sdk.onForeground()
    }

    /** Logout teardown: disconnect (clearSession=true), release the chat mirror, cancel the scope. */
    fun close() {
        sdk.disconnect(clearSession = true)
        component.close()
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
