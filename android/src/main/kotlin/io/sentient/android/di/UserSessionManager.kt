// ---------------------------------------------------------------------------
// UserSessionManager — the User/Connection scope (Koin single).
//
// Models the "logged-in user": owns ONE ChatComponent (+ its SentientSdk + a
// session CoroutineScope), lazily built on first access and background-connected.
// It also owns one CalendarExperience/database for the same authenticated lifetime.
// shutdown() purges/closes that calendar boundary before cancelling the scope and
// nulling the components so the next login rebuilds a fresh session.
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
import android.os.Looper
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.android.calendar.AndroidCalendarDatabaseDriverFactory
import io.sentient.android.calendar.CalendarSessionState
import io.sentient.android.calendar.CalendarSessionUnavailableReason
import io.sentient.android.calendar.calendarCacheNamespace
import io.sentient.android.calendar.normalizedCalendarBackendIdentity
import io.sentient.android.presence.NetworkChangeObserver
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.sdk.AppDependencies
import io.sentient.android.sdk.AuthenticatedUserStore
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.sdk.SdkFaultHolder
import io.sentient.android.sdk.buildAuthHttpClient
import io.sentient.android.sdk.buildSettingsHttpClient
import io.sentient.android.update.UpdateDeps
import io.sentient.android.update.buildUpdateDeps
import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.createCalendarCacheStore
import io.sentient.mobiledata.cache.db.CalendarDatabaseDriverFactory
import io.sentient.mobiledata.cache.db.CalendarDatabaseHandle
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.calendar.CalendarExperienceFactory
import io.sentient.mobiledata.calendar.DefaultCalendarExperienceFactory
import io.sentient.mobiledata.di.CalendarDependencyBoundary
import io.sentient.mobiledata.di.CalendarLifecycleGate
import io.sentient.mobiledata.di.ChatComponent
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferences
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
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Prevents a queued platform callback from reaching a disposed/replaced session. */
internal class SessionConnectivityRecoveryFence(
    private val signal: () -> Unit,
) {
    private val lock = Any()
    private var active = true

    fun signalIfActive() = synchronized(lock) {
        if (active) signal()
    }

    fun close() = synchronized(lock) {
        active = false
    }
}

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
    /** Injected by production Koin; nullable keeps the Android boundary testable without Application startup. */
    private val authenticatedUserStore: AuthenticatedUserStore? = null,
    /** Deterministic lifecycle seam used by platform boundary tests; production leaves it empty. */
    private val beforeCalendarPublish: (suspend (CalendarExperience) -> Unit)? = null,
    /** Production uses app-private storage; tests may supply an isolated app-private database. */
    private val calendarDriverFactory: CalendarDatabaseDriverFactory =
        AndroidCalendarDatabaseDriverFactory(appContext),
) {
    private val log = createLogger("android", "user-session")

    private var scope: CoroutineScope? = null
    private var chatComponent: ChatComponent? = null
    private var settingsComponent: SettingsComponent? = null
    private var networkObserver: NetworkChangeObserver? = null
    private var calendarRecoveryFence: SessionConnectivityRecoveryFence? = null
    private var updateDeps: UpdateDeps? = null
    private var authenticatedUserId: String? = null
    private var activeBackendIdentity: String? = null
    private val calendarLifecycleGate = CalendarLifecycleGate<CalendarRuntime>()
    @Volatile
    private var calendarBoundary: CalendarDependencyBoundary? = null
    private var calendarInitializationJob: kotlinx.coroutines.Job? = null
    private var calendarLifecycleTail: kotlinx.coroutines.Job? = null
    /** Dedicated I/O lifetime; it is never cancelled by the authenticated session scope. */
    private val calendarLifecycleScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _calendarSessionState = MutableStateFlow<CalendarSessionState>(CalendarSessionState.Unauthenticated)
    /** Typed availability for the Android calendar adapter; unavailable never falls back to another store. */
    val calendarSessionState: StateFlow<CalendarSessionState> = _calendarSessionState.asStateFlow()
    val calendarState: StateFlow<CalendarSessionState> get() = calendarSessionState
    /** Explicit identity selected for the current authenticated lifetime. */
    val activeUserId: String? get() = authenticatedUserId ?: authenticatedUserStore?.userId?.value

    /**
     * The active [ChatComponent]. Builds the SDK + scope on first call and launches
     * a background connect(); subsequent calls return the same instance until
     * [shutdown]. Single-threaded build path (Main/composition), so no lock needed.
     */
    fun component(): ChatComponent {
        val userId = authenticatedUserId
            ?: authenticatedUserStore?.userId?.value
            ?: run {
                _calendarSessionState.value = CalendarSessionState.Unavailable(
                    CalendarSessionUnavailableReason.AUTHENTICATED_ID_MISSING,
                )
                throw IllegalStateException("authenticated user identity is unavailable")
            }
        return component(userId)
    }

    /**
     * Build the connection scope for the explicit server-authenticated identity.
     * A different identity is a hard session boundary, never a namespace mutation
     * inferred from a display name or token.
     */
    fun component(explicitUserId: String): ChatComponent {
        val userId = explicitUserId.trim()
        require(userId.isNotEmpty()) { "authenticated user id must not be blank" }
        chatComponent?.let { current ->
            val currentBackendIdentity = runCatching {
                normalizedCalendarBackendIdentity(resolveConfiguredBackend().gatewayWsUrl)
            }.getOrNull()
            if (authenticatedUserId == userId && currentBackendIdentity == activeBackendIdentity) return current
            shutdown()
        }
        authenticatedUserId = userId
        authenticatedUserStore?.save(userId)
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
                log.warn("scope.auth-failure → login", mapOf("errorType" to (e::class.simpleName ?: "unknown")))
                newSdk.signalAuthExpired()
            } else {
                log.warn("scope.transient-caught (recovered)", mapOf("errorType" to (e::class.simpleName ?: "unknown")))
            }
        }
        val sessionScope =
            CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1) + handler)
        val resolvedBackend = resolveConfiguredBackend()
        activeBackendIdentity = runCatching {
            normalizedCalendarBackendIdentity(resolvedBackend.gatewayWsUrl)
        }.getOrNull()
        // No durable resume-cursor store: the SDK's ResumeCursor stays in-memory and
        // defaults to NoOpResumeCursorStore. A cold relaunch takes the recovered:false
        // REST-refetch path (history comes from the gateway/Hermes on attach).
        newSdk = buildSdk(sessionScope, resolvedBackend)
        // Calendar persistence is an asynchronous authenticated-session resource.
        // Settings receives a typed disabled boundary immediately; it can never
        // construct a network-only calendar repository while the protected driver
        // is opening or after setup fails.
        val newCalendarBoundary = CalendarDependencyBoundary.initializing()
        val newCalendarGeneration = calendarLifecycleGate.begin {
            calendarBoundary = newCalendarBoundary
            _calendarSessionState.value = CalendarSessionState.Unavailable(
                CalendarSessionUnavailableReason.INITIALIZING,
            )
        }
        // `loadAudioPreferences` reads `settingsComponent`, assigned a few lines below:
        // the lambda only runs from `connect()`, by which time it is set. Seeds the chat
        // TTS toggle from the stored profile instead of the SDK's default.
        val component = ChatComponent(
            sdk = newSdk,
            loadAudioPreferences = {
                (settingsComponent?.profileRepository?.getProfile() as? SentientResult.Success)
                    ?.data?.audio?.let { AudioPreferences(ttsEnabled = it.ttsEnabled, channel = it.channel) }
            },
        )

        scope = sessionScope
        chatComponent = component
        // Settings slice of the SAME connection scope, built beside chat: it binds its
        // live audio-pref fast-save to the chat component and rolls the shared token store.
        val newSettingsComponent = buildSettingsComponent(
            chat = component,
            backend = resolvedBackend,
            calendarDependency = newCalendarBoundary,
        )
        settingsComponent = newSettingsComponent
        val initializationJob = enqueueCalendarOperation {
            initializeCalendarRuntime(
                userId = userId,
                backend = resolvedBackend,
                settings = newSettingsComponent,
                dependency = newCalendarBoundary,
                generation = newCalendarGeneration,
            )
        }
        if (!calendarLifecycleGate.ifCurrent(newCalendarGeneration) {
                calendarInitializationJob = initializationJob
            }
        ) {
            initializationJob.cancel()
        }

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
                    log.warn("connect.auth-failure → login", mapOf("errorType" to (e::class.simpleName ?: "unknown")))
                    newSdk.signalAuthExpired()
                } else {
                    log.warn("connect.transient-caught (recovered)", mapOf("errorType" to (e::class.simpleName ?: "unknown")))
                }
            }
        }

        // Reconnect on any real path transition. Only unavailable→available also
        // signals the shared calendar recovery intent; shared KMP retains all
        // revalidation/coalescing policy. The generation gate fences old sessions.
        val recoveryFence = SessionConnectivityRecoveryFence {
            calendarLifecycleGate.ifCurrent(newCalendarGeneration) {
                log.info("calendar-connectivity-recovered", mapOf("generation" to newCalendarGeneration))
                calendarBoundary?.experience?.onConnectivityRecovered()
            }
        }
        calendarRecoveryFence = recoveryFence
        networkObserver = NetworkChangeObserver(
            appContext = appContext,
            onChange = {
                chatComponent?.let {
                    log.info("network-changed → ensureConnected")
                    it.ensureConnected()
                }
            },
            onConnectivityRecovered = recoveryFence::signalIfActive,
            onConnectivityUnavailable = {
                calendarLifecycleGate.ifCurrent(newCalendarGeneration) {
                    log.info("calendar-connectivity-unavailable", mapOf("generation" to newCalendarGeneration))
                    calendarBoundary?.experience?.onConnectivityUnavailable()
                }
            },
        ).also { it.start() }

        return component
    }

    /** Capture the server-authenticated id before the session is first resolved by Koin. */
    fun beginAuthenticatedSession(serverAuthenticatedUserId: String) {
        val userId = serverAuthenticatedUserId.trim()
        require(userId.isNotEmpty()) { "authenticated user id must not be blank" }
        if (chatComponent != null && authenticatedUserId != userId) shutdown()
        authenticatedUserId = userId
        authenticatedUserStore?.save(userId)
    }

    /** Shared experience for the current authenticated lifetime; null means typed unavailable. */
    fun calendarExperience(): CalendarExperience? = calendarBoundary?.experience

    /** Terminal authentication failure follows the host's authenticated-session teardown path. */
    fun onAuthenticationExpired() = performLocalLogout()

    /** Backend replacement is a logout boundary even when the setup screen owns the route. */
    fun onBackendReplaced() = performLocalLogout()

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

    /** Queue calendar lifecycle work without ever parking the caller. */
    private fun enqueueCalendarOperation(block: suspend () -> Unit): kotlinx.coroutines.Job {
        val previous = calendarLifecycleTail
        val job = calendarLifecycleScope.launch {
            // Joining a cancelled predecessor is intentional: its finally block
            // closes any partially-open driver before the successor starts.
            previous?.join()
            block()
        }
        calendarLifecycleTail = job
        job.invokeOnCompletion {
            if (calendarLifecycleTail === job) calendarLifecycleTail = null
        }
        return job
    }

    /**
     * Open/migrate the protected database on Dispatchers.IO, then install the
     * one repository/experience into the already-published fail-closed boundary.
     */
    private suspend fun initializeCalendarRuntime(
        userId: String,
        backend: ResolvedBackend.Configured,
        settings: SettingsComponent,
        dependency: CalendarDependencyBoundary,
        generation: Long,
    ) {
        val runtime = buildCalendarRuntime(userId, backend, dependency, generation)
        if (runtime == null) return
        var transferred = false
        try {
            // Everything up to this point is locally owned. In particular, the
            // experience is not installed in SettingsComponent while the barrier
            // is paused, so logout can invalidate this generation safely.
            val prepared = settings.prepareCalendarExperience(runtime.factory)
                ?: throw IllegalStateException()
            runtime.experience = prepared.experience
            beforeCalendarPublish?.invoke(prepared.experience)
            transferred = calendarLifecycleGate.publish(generation, runtime) {
                if (calendarBoundary !== dependency) {
                    false
                } else {
                    settings.installPreparedCalendarExperience(prepared) {
                        _calendarSessionState.value = CalendarSessionState.Available(
                            namespace = runtime.namespace,
                            experience = prepared.experience,
                        )
                    }
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            markCalendarUnavailableIfCurrent(
                generation = generation,
                dependency = dependency,
                dependencyReason = io.sentient.mobiledata.di.CalendarDependencyUnavailableReason.STORE_OPEN_FAILED,
                sessionReason = CalendarSessionUnavailableReason.DATABASE_OPEN,
            )
        } finally {
            // A failed generation retains ownership here. It must purge/close
            // even when close() already queued a teardown for a null active slot.
            if (!transferred) runtime.closeAndPurge()
        }
    }

    private fun markCalendarUnavailableIfCurrent(
        generation: Long,
        dependency: CalendarDependencyBoundary,
        dependencyReason: io.sentient.mobiledata.di.CalendarDependencyUnavailableReason,
        sessionReason: CalendarSessionUnavailableReason,
    ) {
        calendarLifecycleGate.ifCurrent(generation) {
            if (calendarBoundary === dependency) {
                dependency.disable(dependencyReason)
                _calendarSessionState.value = CalendarSessionState.Unavailable(sessionReason)
            }
        }
    }

    /**
     * Opens the Android database only after an explicit identity and backend
     * have been captured. Any protected-path/open/migration failure becomes the
     * typed unavailable state; no alternate path or in-memory replacement is attempted.
     */
    private suspend fun buildCalendarRuntime(
        userId: String,
        backend: ResolvedBackend.Configured,
        dependency: CalendarDependencyBoundary,
        generation: Long,
    ): CalendarRuntime? = withContext(Dispatchers.IO) {
        check(Looper.myLooper() != Looper.getMainLooper())
        val namespace = try {
            calendarCacheNamespace(userId, backend.gatewayWsUrl)
        } catch (failure: Throwable) {
            if (failure is CancellationException) throw failure
            markCalendarUnavailableIfCurrent(
                generation = generation,
                dependency = dependency,
                dependencyReason = io.sentient.mobiledata.di.CalendarDependencyUnavailableReason.INVALID_BACKEND_IDENTITY,
                sessionReason = CalendarSessionUnavailableReason.BACKEND_IDENTITY_INVALID,
            )
            return@withContext null
        }

        var handle: CalendarDatabaseHandle? = null
        var store: CalendarCacheStore? = null
        var transferred = false
        try {
            val openedHandle = openCalendarDatabase(calendarDriverFactory)
            handle = openedHandle
            val openedStore = createCalendarCacheStore(
                handle = openedHandle,
                namespace = namespace,
                observationContext = Dispatchers.IO,
            )
            store = openedStore
            val experienceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val factory: CalendarExperienceFactory = DefaultCalendarExperienceFactory(
                cacheStore = openedStore,
                scope = experienceScope,
            )
            transferred = true
            CalendarRuntime(
                namespace = namespace,
                store = openedStore,
                factory = factory,
                experienceScope = experienceScope,
            )
        } catch (failure: Throwable) {
            if (failure is CancellationException) throw failure
            markCalendarUnavailableIfCurrent(
                generation = generation,
                dependency = dependency,
                dependencyReason = io.sentient.mobiledata.di.CalendarDependencyUnavailableReason.DATABASE_OPEN,
                sessionReason = CalendarSessionUnavailableReason.DATABASE_OPEN,
            )
            null
        } finally {
            if (!transferred) {
                runCatching { store?.close() }
                runCatching { handle?.close() }
            }
        }
    }

    /**
     * Builds the settings slice: a DEDICATED long-timeout HttpClient (Hermes-restart
     * apply blocks multi-seconds), the resolved host, the shared token store (read per
     * request + rolled on rename), the live audio patch bound to [chat], and logout.
     */
    private fun buildSettingsComponent(
        chat: ChatComponent,
        backend: ResolvedBackend.Configured,
        calendarDependency: CalendarDependencyBoundary,
    ): SettingsComponent {
        val tokenStore = AppDependencies.tokenStore
        return SettingsComponent(
            httpClient = buildSettingsHttpClient(backend.allowSelfSignedDevHost),
            gatewayWsUrl = backend.gatewayWsUrl,
            token = { tokenStore.load() ?: "" },
            liveAudioPatch = chat::patchAudioPreferences,
            onTokenRefreshed = { token -> tokenStore.save(token) },
            onLoggedOut = { performLocalLogout() },
            calendarDependency = calendarDependency,
        )
    }

    private fun buildSdk(
        sessionScope: CoroutineScope,
        backend: ResolvedBackend.Configured,
    ): SentientSdk {
        val r = backend
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
     * Local logout teardown for the settings AccountUseCases `onLoggedOut` hook:
     * dispose the calendar before clearing the explicit identity and auth gate.
     * That keeps a successor login from racing the predecessor purge.
     */
    fun performLocalLogout() {
        log.info("local-logout")
        shutdown()
        AppDependencies.tokenStore.clear()
        DisplayNameHolder.store.clear()
        authenticatedUserStore?.clear()
    }

    /**
     * Logout teardown. Calendar collectors are invalidated first, then a fresh
     * bounded non-cancelled context purges the active namespace, closes the
     * experience/driver, and only then is the session scope cancelled and DI
     * cleared. Idempotent for route recreation and repeated auth-expiry signals.
     */
    fun shutdown() {
        log.info("shutdown")
        presence?.unbind()
        calendarRecoveryFence?.close()
        calendarRecoveryFence = null
        networkObserver?.stop()
        networkObserver = null

        // The gate invalidates the generation and captures the active runtime in
        // one critical section. An initializer paused before publish therefore
        // cannot publish after this point; it retains and closes its local runtime.
        val oldCalendarRuntime = calendarLifecycleGate.close {
            calendarInitializationJob?.cancel()
            calendarInitializationJob = null
            calendarBoundary?.disable(
                io.sentient.mobiledata.di.CalendarDependencyUnavailableReason.CLOSED,
            )
            calendarBoundary = null
            _calendarSessionState.value = CalendarSessionState.Unauthenticated
        }
        // Teardown is queued after any cancelled/opening operation and runs on
        // the dedicated I/O scope. Logout therefore never parks the UI caller.
        calendarLifecycleTail = enqueueCalendarOperation {
            oldCalendarRuntime?.closeAndPurge()
        }

        chatComponent?.disconnect(clearSession = true)
        chatComponent?.close()
        scope?.cancel()
        if (io.sentient.android.BuildConfig.DEBUG) SdkFaultHolder.clear()
        chatComponent = null
        settingsComponent = null
        scope = null
        authenticatedUserId = null
        activeBackendIdentity = null
        // Drop the update deps so a re-login rebuilds them against the current backend.
        updateDeps = null
    }

    /** Test/app lifecycle seam: waits without moving the wait onto the caller's dispatcher. */
    suspend fun awaitCalendarLifecycle() {
        calendarLifecycleTail?.join()
    }

    private class CalendarRuntime(
        val namespace: CalendarCacheNamespace,
        val store: CalendarCacheStore,
        val factory: CalendarExperienceFactory,
        private val experienceScope: CoroutineScope,
        @Volatile var experience: CalendarExperience? = null,
    ) {
        /** Bounded purge/close on the already-background I/O executor. */
        suspend fun closeAndPurge() = withContext(NonCancellable) {
            check(Looper.myLooper() != Looper.getMainLooper())
            val currentExperience = experience
            try {
                withTimeout(CALENDAR_SESSION_PURGE_TIMEOUT_MS) {
                    if (currentExperience != null) {
                        currentExperience.disposeAndPurge()
                    } else {
                        store.purgeNamespace(namespace)
                    }
                }
            } catch (_: TimeoutCancellationException) {
                // The bounded teardown still closes below; diagnostics stay structural.
            } catch (failure: Throwable) {
                // Logout still clears the session on database failure; never rethrow
                // a driver message or payload during teardown.
                if (failure is CancellationException) throw failure
            } finally {
                runCatching { currentExperience?.close() }
                runCatching { store.close() }
                experienceScope.cancel()
            }
        }
    }

    private companion object {
        const val CALENDAR_SESSION_PURGE_TIMEOUT_MS: Long = 5_000L
    }
}
