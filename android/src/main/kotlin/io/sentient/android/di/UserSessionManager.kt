// ---------------------------------------------------------------------------
// UserSessionManager — the User/Connection scope (Koin single).
//
// Models the "logged-in user": owns ONE ChatComponent (+ its SentientSdk + a
// session CoroutineScope), lazily built on first access and background-connected.
// shutdown() (logout) disconnects clearSession=true, cancels the scope, and nulls
// the component so the next login rebuilds a fresh SDK/connection.
//
// Replaces the old per-chat-entry SdkSessionFactory.create() + MobileSession: the
// SDK now lives for the duration of a login, and switching conversation is a
// navigation that recreates the chat ViewModel (NOT a new SDK).
//
// Presence: pause()/resume() forward foreground/background to the component's SDK
// passthroughs. pause() drops the socket but keeps the user in session
// (clearSession=false); resume() re-arms reconnect. Wired to the app-scoped
// PresenceCoordinator via bindPresence().
// ---------------------------------------------------------------------------
package io.sentient.android.di

import android.content.Context
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.android.presence.NetworkChangeObserver
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.sdk.AppDependencies
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.SdkFaultHolder
import io.sentient.android.sdk.buildAuthHttpClient
import io.sentient.android.sdk.buildSettingsHttpClient
import io.sentient.android.update.UpdateDeps
import io.sentient.android.update.buildUpdateDeps
import io.sentient.mobiledata.di.ChatComponent
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.sdk.isTerminalAuthError
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.UpdateChecker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * One per logged-in user (Koin single). Lazily builds the SDK + ChatComponent on
 * first [component] call and background-connects; [shutdown] tears it down on logout.
 *
 * Requirements:
 *  - [MobileSdk.initAndroid] MUST have run (SentientApp.onCreate) before first use.
 *  - A configured backend MUST be available (resolve returns Configured).
 */
class UserSessionManager(
    private val appContext: Context,
    private val presence: PresenceCoordinator? = null,
) {
    private val log = createLogger("android", "user-session")

    private var scope: CoroutineScope? = null
    private var chatComponent: ChatComponent? = null
    private var settingsComponent: SettingsComponent? = null
    private var networkObserver: NetworkChangeObserver? = null
    private var updateDeps: UpdateDeps? = null

    /**
     * The active [ChatComponent]. Builds the SDK + scope on first call and launches
     * a background connect(); subsequent calls return the same instance until
     * [shutdown]. Single-threaded build path (Main/composition), so no lock needed.
     */
    fun component(): ChatComponent {
        chatComponent?.let { return it }
        log.info("build")

        // SDK is built first so the scope's CoroutineExceptionHandler can route an
        // uncaught throw to it. A SupervisorJob does NOT install a handler — without
        // this, an uncaught throw hits the global handler and crashes the process.
        // Classify + route, NEVER rethrow: CancellationException → normal teardown;
        // terminal auth → signalAuthExpired() (ConnectionState.authExpired → login
        // route); transient → log + recover (the reconnect supervisor retries).
        lateinit var newSdk: SentientSdk
        val handler = CoroutineExceptionHandler { _, e ->
            if (e is CancellationException) return@CoroutineExceptionHandler
            if (isTerminalAuthError(e)) {
                log.warn("scope.auth-failure → login", mapOf("error" to (e.message ?: "")))
                newSdk.signalAuthExpired()
            } else {
                log.warn("scope.transient-caught (recovered)", mapOf("error" to (e.message ?: "")))
            }
        }
        val sessionScope =
            CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1) + handler)
        // No durable resume-cursor store: the SDK's ResumeCursor stays in-memory and
        // defaults to NoOpResumeCursorStore. A cold relaunch takes the recovered:false
        // REST-refetch path (history comes from the gateway/Hermes on attach).
        newSdk = buildSdk(sessionScope)
        val component = ChatComponent(sdk = newSdk)

        scope = sessionScope
        chatComponent = component
        // Settings slice of the SAME connection scope, built beside chat: it binds its
        // live audio-pref fast-save to the chat component and rolls the shared token store.
        settingsComponent = buildSettingsComponent(component)

        // DEBUG-only: expose the live SDK to DebugFaultReceiver so Maestro can arm
        // faults via `adb shell am broadcast`. WeakReference — logout/GC unaffected.
        if (io.sentient.android.BuildConfig.DEBUG) SdkFaultHolder.set(newSdk)

        // Background connect: UI is usable immediately; reconnect is owned by the SDK.
        // Belt-and-braces guard for a SYNCHRONOUS throw before the first suspension
        // (the handler covers throws after suspension). Same classify + route.
        sessionScope.launch {
            try {
                component.connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (isTerminalAuthError(e)) {
                    log.warn("connect.auth-failure → login", mapOf("error" to (e.message ?: "")))
                    newSdk.signalAuthExpired()
                } else {
                    log.warn("connect.transient-caught (recovered)", mapOf("error" to (e.message ?: "")))
                }
            }
        }

        // Reconnect on a network-path change (VPN→WiFi, etc.): verify the socket so a
        // queued send is never stranded on a dead-but-"READY" connection.
        networkObserver = NetworkChangeObserver(appContext) {
            chatComponent?.let {
                log.info("network-changed → ensureConnected")
                it.ensureConnected()
            }
        }.also { it.start() }

        return component
    }

    /**
     * The active [SettingsComponent] (settings REST clients → repos → usecases), built
     * beside the [ChatComponent] on the same connection scope. Per-route settings VMs
     * resolve their usecases from here. Triggers the chat/SDK build if it hasn't run yet
     * (the settings audio fast-save binds to the live chat component). Rebuilt across
     * logout→login; never a process-wide singleton (would go stale after re-login).
     */
    fun settingsComponent(): SettingsComponent {
        settingsComponent?.let { return it }
        component() // builds SDK + chat + settings together
        return checkNotNull(settingsComponent) { "settingsComponent build failed" }
    }

    /**
     * Builds the settings slice: a DEDICATED long-timeout HttpClient (Hermes-restart
     * apply blocks multi-seconds), the resolved host, the shared token store (read per
     * request + rolled on rename), the live audio patch bound to [chat], and logout.
     */
    private fun buildSettingsComponent(chat: ChatComponent): SettingsComponent {
        val r = resolveConfiguredBackend()
        val tokenStore = AppDependencies.tokenStore
        return SettingsComponent(
            httpClient = buildSettingsHttpClient(r.allowSelfSignedDevHost),
            gatewayWsUrl = r.gatewayWsUrl,
            token = { tokenStore.load() ?: "" },
            liveAudioPatch = chat::patchAudioPreferences,
            onTokenRefreshed = { token -> tokenStore.save(token) },
            onLoggedOut = { performLocalLogout() },
        )
    }

    private fun buildSdk(sessionScope: CoroutineScope): SentientSdk {
        val r = resolveConfiguredBackend()
        val config = SdkConfig(
            gatewayWsUrl = r.gatewayWsUrl,
            allowSelfSignedDevHost = r.allowSelfSignedDevHost,
            capabilities = AppDependencies.capabilities,
            devFaultsEnabled = io.sentient.android.BuildConfig.DEBUG,
        )
        // Build the platform bundle once so the token store is shared between the
        // SDK WS transport and the REST SessionsHttpClient (same SecureTokenStore).
        val bundle = createPlatformBundle()
        // REST HTTP client for session queries: reuse the same OkHttp engine + TLS
        // policy as the AuthClient so the dev self-signed bypass is applied once.
        val sessionsHttpClient = SessionsHttpClient(
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
            gatewayWsUrl = r.gatewayWsUrl,
            token = { bundle.tokenStore.load() ?: "" },
        )
        return SentientSdk(
            config = config,
            bundle = bundle,
            scope = sessionScope,
            sessionsHttpClient = sessionsHttpClient,
        )
    }

    /** The resolved backend, or throw — every session/update dep needs a configured host. */
    private fun resolveConfiguredBackend(): ResolvedBackend.Configured {
        val r = resolveBackend(
            override = BackendConfigHolder.store.config.value,
            buildTimeDefaultUrl = io.sentient.android.BuildConfig.GATEWAY_WS_URL,
            buildTimeAllowSelfSigned = io.sentient.android.BuildConfig.DEBUG,
        )
        require(r is ResolvedBackend.Configured) {
            "UserSessionManager accessed while backend unconfigured"
        }
        return r
    }

    /** Connection-scoped OTA checker. Built lazily from the resolved gateway host;
     *  reset by [shutdown] so a re-login rebuilds against the current backend. */
    fun updateChecker(): UpdateChecker = updateDeps().checker

    /** Connection-scoped OTA installer (downloads the apk + opens PackageInstaller). */
    fun updateInstaller(): AppUpdateInstaller = updateDeps().installer

    private fun updateDeps(): UpdateDeps = updateDeps ?: run {
        val r = resolveConfiguredBackend()
        // Reuse one Ktor client (JSON ContentNegotiation + dev TLS bypass) for both the
        // manifest fetch and the apk download — same engine/TLS policy as the AuthClient.
        buildUpdateDeps(
            appContext = appContext,
            gatewayWsUrl = r.gatewayWsUrl,
            httpClient = buildAuthHttpClient(r.allowSelfSignedDevHost),
            installedBuild = io.sentient.android.BuildConfig.VERSION_CODE,
            installedVersionName = io.sentient.android.BuildConfig.VERSION_NAME,
        ).also { updateDeps = it }
    }

    /** App foreground → one-shot liveness probe; reconnect (+ resume session) only if dead. */
    fun resume() {
        val c = chatComponent ?: return
        log.info("resume")
        c.onForeground()
    }

    /**
     * App background → KEEP the socket. The gateway holds the per-user session + ACP
     * wire on detach and has no server ping/timeout, so a brief backgrounding survives
     * on the SAME socket (no reload, no reconnect, no audio teardown). The OS suspends
     * the process; a genuinely dead socket is caught by the foreground probe in [resume].
     */
    fun pause() {
        // Do NOT drop the socket on background. See [resume].
    }

    /**
     * Attach this session's pause/resume to the app-scoped presence relay.
     *
     * [onForegroundExtra] rides the SAME foreground signal (so it inherits the relay's
     * COLD-START-SKIP — it never fires on the first foreground after launch). Used to
     * trigger the OTA update check on a real foreground without giving the relay any
     * update knowledge. The relay's bind is last-wins, so this MUST be the single bind
     * site that composes both concerns.
     */
    fun bindPresence(onForegroundExtra: () -> Unit = {}) {
        presence?.bind(
            onForeground = { resume(); onForegroundExtra() },
            onBackground = ::pause,
        )
    }

    /**
     * Local logout teardown for the settings AccountUseCases `onLoggedOut` hook: clear
     * the token + display name (flips the auth gate) then tear down via [shutdown].
     * Mirrors the root-screen logout minus navigation (the screen observes the gate).
     */
    fun performLocalLogout() {
        log.info("local-logout")
        AppDependencies.tokenStore.clear()
        DisplayNameHolder.store.clear()
        shutdown()
    }

    /**
     * Logout teardown: disconnect (clearSession=true), cancel the session scope, and
     * null the components so the next [component] call rebuilds a fresh SDK. Idempotent.
     */
    fun shutdown() {
        log.info("shutdown")
        presence?.unbind()
        networkObserver?.stop()
        networkObserver = null
        chatComponent?.disconnect(clearSession = true)
        chatComponent?.close()
        scope?.cancel()
        if (io.sentient.android.BuildConfig.DEBUG) SdkFaultHolder.clear()
        chatComponent = null
        settingsComponent = null
        scope = null
        // Drop the update deps so a re-login rebuilds them against the current backend.
        updateDeps = null
    }
}
