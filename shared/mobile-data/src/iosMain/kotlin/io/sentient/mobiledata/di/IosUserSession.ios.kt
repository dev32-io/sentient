// ---------------------------------------------------------------------------
// IosUserSession — the User/Connection scope for iOS (SKIE-exposed to Swift).
//
// The authenticated session publishes its settings component immediately with a
// typed, fail-closed calendar boundary. Application Support/NativeSqliteDriver
// setup is queued on a background executor and installed only after open,
// migration, and protection checks succeed. Route recreation therefore never
// rebuilds the experience, while MainActor construction never performs database
// I/O.
// ---------------------------------------------------------------------------
@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package io.sentient.mobiledata.di

import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.createCalendarCacheStore
import io.sentient.mobiledata.cache.db.CalendarDatabaseDriverFactory
import io.sentient.mobiledata.cache.db.CalendarDatabaseHandle
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.calendar.CalendarExperienceFactory
import io.sentient.mobiledata.calendar.createCalendarExperience
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.sdk.isTerminalAuthError
import io.sentient.mobilesdk.sessions.createSessionsHttpClient
import io.sentient.mobilesdk.settings.createSettingsHttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.Volatile

private const val IOS_CALENDAR_TEARDOWN_TIMEOUT_MILLIS = 2_000L
private const val IOS_INVALID_GATEWAY_WS_URL = "ws://invalid.invalid/api/v1/ws"

private fun safeIosGatewayWsUrl(gatewayWsUrl: String): String = try {
    normalizeIosBackendIdentity(gatewayWsUrl)
    gatewayWsUrl
} catch (_: Throwable) {
    // Invalid/user-controlled endpoint material never reaches a transport
    // factory or its diagnostics.
    IOS_INVALID_GATEWAY_WS_URL
}

/** Serialize database open/dispose operations across successor sessions. */
private object IosCalendarLifecycleQueue {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tail = AtomicReference<Deferred<Unit>?>(null)

    fun enqueue(block: suspend () -> Unit): Deferred<Unit> {
        val previous = tail.load()
        val next = scope.async(start = CoroutineStart.LAZY) {
            // A failed predecessor must not strand a new authenticated session;
            // its own finally block is responsible for closing its resources.
            try {
                previous?.await()
            } catch (_: Throwable) {
                // Structural lifecycle queue failure; no predecessor detail escapes.
            }
            block()
        }
        tail.store(next)
        next.start()
        return next
    }
}

/** Runtime owns the store, experience, and the background scope used by both. */
private class IosCalendarRuntime(
    val namespace: CalendarCacheNamespace,
    private val cacheStore: CalendarCacheStore,
    val factory: CalendarExperienceFactory,
    val experienceScope: CoroutineScope,
    @Volatile var experience: CalendarExperience? = null,
) {
    private var disposed = false

    suspend fun disposeAndPurge(): CalendarCacheResult<Unit> = withContext(NonCancellable) {
        if (disposed) return@withContext CalendarCacheResult.Success(Unit)
        disposed = true
        try {
            experience?.disposeAndPurge() ?: cacheStore.purgeNamespace(namespace)
        } finally {
            runCatching { experience?.close() }
            runCatching { cacheStore.close() }
            experienceScope.cancel()
        }
    }

    fun forceClose() {
        disposed = true
        runCatching { experience?.close() }
        runCatching { cacheStore.close() }
        experienceScope.cancel()
    }
}

/** One protected calendar lifetime above NavigationStack route recreation. */
class IosUserSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    authenticatedUserId: String,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
    /** Clear-local-session hook for settings Account logout. */
    onLoggedOut: () -> Unit = {},
    /** Deterministic lifecycle seam used by platform boundary tests; production leaves it empty. */
    private val beforeCalendarPublish: (suspend (CalendarExperience) -> Unit)? = null,
    /** Production uses protected Application Support; tests may supply an isolated native database. */
    private val calendarDriverFactory: CalendarDatabaseDriverFactory = IosCalendarDatabaseDriverFactory(),
) {
    private val log = createLogger("data", "ios-user-session")
    private val userId = authenticatedUserId.trim()
    private val safeGatewayWsUrl = safeIosGatewayWsUrl(gatewayWsUrl)

    @Volatile
    private var closed = false
    private val calendarLifecycleGate = CalendarLifecycleGate<IosCalendarRuntime>()
    @Volatile
    private var calendarDisposalJob: Deferred<Unit>? = null

    private val exceptionHandler = CoroutineExceptionHandler { _, e ->
        if (e is CancellationException) return@CoroutineExceptionHandler
        if (isTerminalAuthError(e)) {
            log.warn("scope.auth-failure", mapOf("code" to "auth-expired"))
            sdk.signalAuthExpired()
        } else {
            log.warn("scope.transient-caught", mapOf("code" to "scope-failure"))
        }
    }

    private val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1) + exceptionHandler)

    /** Separate background lifetime so close can purge before cancelling it. */
    private val calendarScope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

    private val bundle = createPlatformBundle()

    private val sessionsHttpClient = createSessionsHttpClient(
        gatewayWsUrl = safeGatewayWsUrl,
        allowSelfSignedDevHost = allowSelfSignedDevHost,
        token = { bundle.tokenStore.load() ?: "" },
    )

    private val sdk: SentientSdk = SentientSdk(
        config = SdkConfig(
            gatewayWsUrl = safeGatewayWsUrl,
            allowSelfSignedDevHost = allowSelfSignedDevHost,
            capabilities = capabilities,
            devFaultsEnabled = devFaultsEnabled,
        ),
        bundle = bundle,
        scope = scope,
        sessionsHttpClient = sessionsHttpClient,
    )

    /** The single ChatComponent for this login. */
    val component: ChatComponent = ChatComponent(
        sdk = sdk,
        loadAudioPreferences = {
            (settings.profileRepository.getProfile() as? SentientResult.Success)?.data?.audio?.let {
                AudioPreferences(ttsEnabled = it.ttsEnabled, channel = it.channel)
            }
        },
    )

    private val settingsHttpClient = createSettingsHttpClient(allowSelfSignedDevHost)
    private val calendarDependency = CalendarDependencyBoundary.initializing()

    /** Namespace derivation is synchronous and content-free; database work is not. */
    private val initialCalendarNamespace: CalendarCacheNamespace? = try {
        iosCalendarNamespace(userId, gatewayWsUrl)
    } catch (failure: IosCalendarDatabaseFailure) {
        calendarDependency.disable(failure.reason.toDependencyReason())
        null
    } catch (_: Throwable) {
        calendarDependency.disable(CalendarDependencyUnavailableReason.INVALID_BACKEND_IDENTITY)
        null
    }

    /**
     * Settings is safe to expose before the database is ready: its calendar
     * usecases point at the boundary's disabled delegate, never at the network.
     */
    val settings: SettingsComponent = SettingsComponent(
        httpClient = settingsHttpClient,
        gatewayWsUrl = safeGatewayWsUrl,
        token = { bundle.tokenStore.load() ?: "" },
        liveAudioPatch = component::patchAudioPreferences,
        onTokenRefreshed = { bundle.tokenStore.save(it) },
        onLoggedOut = onLoggedOut,
        calendarDependency = calendarDependency,
    )

    /** Background initialization is queued after any predecessor teardown. */
    private val calendarInitializationGeneration: Long = calendarLifecycleGate.begin()
    private val calendarInitializationJob: Deferred<Unit> = IosCalendarLifecycleQueue.enqueue {
        initializeCalendar(calendarInitializationGeneration)
    }

    /** Explicit identity retained by this authenticated boundary. */
    val authenticatedUserId: String get() = userId

    /** One shared calendar experience for the authenticated lifetime, if available. */
    val calendarExperience: CalendarExperience?
        get() = calendarDependency.experience

    /** Typed fail-closed state for protected calendar storage. */
    val calendarAvailability: IosCalendarAvailability
        get() = calendarDependency.state.value.toIosAvailability()

    /** Namespace is published only after the protected runtime is installed. */
    val calendarNamespace: CalendarCacheNamespace?
        get() = calendarDependency.experience?.let { calendarLifecycleGate.active()?.namespace }

    /** Background connect: UI is usable immediately; reconnect is owned by the SDK. */
    fun open() {
        scope.launch {
            try {
                component.connect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (isTerminalAuthError(e)) {
                    log.warn("open.auth-failure", mapOf("code" to "auth-expired"))
                    sdk.signalAuthExpired()
                } else {
                    log.warn("open.transient-caught", mapOf("code" to "connect-failure"))
                }
            }
        }
    }

    fun pause() {
        // Keep the authenticated socket while backgrounded.
    }

    fun resume() {
        sdk.onForeground()
    }

    /** Explicit settings/root logout entry point. */
    fun explicitLogout() = close()

    /** Terminal authentication failure entry point. */
    fun authenticationExpired() = close()

    /** Account replacement invalidates this authenticated owner before successor creation. */
    fun accountReplaced() = close()

    /** Backend replacement invalidates this authenticated owner before successor creation. */
    fun backendReplaced() = close()

    /**
     * Non-blocking disposal boundary. The purge and NativeSqliteDriver close
     * run on the lifecycle queue's Default executor; MainActor callers only
     * publish the closed state and schedule the operation.
     */
    fun close() {
        if (closed) return
        closed = true
        // Invalidate the generation before capturing the active runtime. The
        // initializer's publish step uses this same gate, so a paused local
        // runtime can only be rejected and self-disposed.
        val runtimeAtClose = calendarLifecycleGate.close {
            calendarDependency.disable(CalendarDependencyUnavailableReason.CLOSED)
        }
        calendarDisposalJob = IosCalendarLifecycleQueue.enqueue {
            disposeRuntime(runtimeAtClose)
            calendarScope.cancel()
        }

        sdk.disconnect(clearSession = true)
        component.close()
        scope.cancel()
        settingsHttpClient.close()
    }

    /** Await the background open or disposal in tests and lifecycle coordinators. */
    suspend fun awaitCalendarLifecycle() {
        calendarDisposalJob?.await() ?: calendarInitializationJob.await()
    }

    private suspend fun initializeCalendar(generation: Long) {
        val namespace = initialCalendarNamespace ?: return
        val runtime = buildCalendarRuntime(namespace, generation) ?: return
        var transferred = false
        try {
            // The protected driver/store/experience remain local until this
            // single generation-checked publish. A barrier can pause here
            // without making the runtime visible to Settings or the session.
            val prepared = settings.prepareCalendarExperience(runtime.factory)
                ?: throw IllegalStateException()
            runtime.experience = prepared.experience
            beforeCalendarPublish?.invoke(prepared.experience)
            transferred = calendarLifecycleGate.publish(generation, runtime) {
                settings.installPreparedCalendarExperience(prepared)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            disableCalendarIfCurrent(generation, CalendarDependencyUnavailableReason.STORE_OPEN_FAILED)
        } finally {
            if (!transferred) {
                // A rejected publish still owns this local driver/experience.
                runtime.disposeAndPurge()
            }
        }
    }

    private fun disableCalendarIfCurrent(
        generation: Long,
        reason: CalendarDependencyUnavailableReason,
    ) {
        calendarLifecycleGate.ifCurrent(generation) {
            calendarDependency.disable(reason)
        }
    }

    private suspend fun buildCalendarRuntime(
        namespace: CalendarCacheNamespace,
        generation: Long,
    ): IosCalendarRuntime? =
        withContext(Dispatchers.Default) {
            var handle: CalendarDatabaseHandle? = null
            var store: CalendarCacheStore? = null
            var transferred = false
            try {
                val openedHandle = openCalendarDatabase(calendarDriverFactory)
                handle = openedHandle
                val openedStore = createCalendarCacheStore(
                    handle = openedHandle,
                    namespace = namespace,
                    observationContext = Dispatchers.Default,
                )
                store = openedStore
                val experienceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                // SettingsComponent creates the one remote repository only after
                // this protected store is open, then supplies that repository to
                // this factory. No network repository is created on failure.
                val factory = CalendarExperienceFactory { repository ->
                    createCalendarExperience(
                        repository = repository,
                        cacheStore = openedStore,
                        scope = experienceScope,
                    )
                }
                transferred = true
                IosCalendarRuntime(
                    namespace = namespace,
                    cacheStore = openedStore,
                    factory = factory,
                    experienceScope = experienceScope,
                )
            } catch (failure: IosCalendarDatabaseFailure) {
                disableCalendarIfCurrent(generation, failure.reason.toDependencyReason())
                null
            } catch (_: Throwable) {
                disableCalendarIfCurrent(generation, CalendarDependencyUnavailableReason.STORE_OPEN_FAILED)
                null
            } finally {
                if (!transferred) {
                    runCatching { store?.close() }
                    runCatching { handle?.close() }
                }
            }
        }

    private suspend fun disposeRuntime(runtime: IosCalendarRuntime?) {
        if (runtime == null) return
        try {
            withContext(NonCancellable) {
                withTimeout(IOS_CALENDAR_TEARDOWN_TIMEOUT_MILLIS) {
                    val result = runtime.disposeAndPurge()
                    if (result is CalendarCacheResult.Failure) {
                        log.warn("calendar.purge-failed", mapOf("code" to result.error.reason.name))
                    }
                }
            }
        } catch (_: Throwable) {
            runtime.forceClose()
            log.warn("calendar.close-failed", mapOf("code" to "bounded-teardown"))
        }
    }
}

/** Build an [IosUserSession] for Swift/SKIE with explicit server identity. */
fun createUserSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    authenticatedUserId: String,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
    onLoggedOut: () -> Unit = {},
): IosUserSession = IosUserSession(
    gatewayWsUrl = gatewayWsUrl,
    allowSelfSignedDevHost = allowSelfSignedDevHost,
    authenticatedUserId = authenticatedUserId,
    capabilities = capabilities,
    devFaultsEnabled = devFaultsEnabled,
    onLoggedOut = onLoggedOut,
)

private fun IosCalendarUnavailableReason.toDependencyReason(): CalendarDependencyUnavailableReason = when (this) {
    IosCalendarUnavailableReason.INITIALIZING -> CalendarDependencyUnavailableReason.INITIALIZING
    IosCalendarUnavailableReason.CLOSED -> CalendarDependencyUnavailableReason.CLOSED
    IosCalendarUnavailableReason.MISSING_AUTHENTICATED_USER_ID ->
        CalendarDependencyUnavailableReason.MISSING_AUTHENTICATED_USER_ID
    IosCalendarUnavailableReason.INVALID_BACKEND_IDENTITY ->
        CalendarDependencyUnavailableReason.INVALID_BACKEND_IDENTITY
    IosCalendarUnavailableReason.APPLICATION_SUPPORT_UNAVAILABLE,
    IosCalendarUnavailableReason.PROTECTION_UNAVAILABLE ->
        CalendarDependencyUnavailableReason.PROTECTED_STORAGE
    IosCalendarUnavailableReason.MIGRATION_FAILED ->
        CalendarDependencyUnavailableReason.MIGRATION_FAILED
    IosCalendarUnavailableReason.DRIVER_OPEN_FAILED,
    IosCalendarUnavailableReason.STORE_OPEN_FAILED ->
        CalendarDependencyUnavailableReason.STORE_OPEN_FAILED
}

private fun CalendarDependencyState.toIosAvailability(): IosCalendarAvailability = when (this) {
    is CalendarDependencyState.Available -> IosCalendarAvailability.available()
    is CalendarDependencyState.Unavailable -> IosCalendarAvailability.unavailable(
        when (reason) {
            CalendarDependencyUnavailableReason.INITIALIZING -> IosCalendarUnavailableReason.INITIALIZING
            CalendarDependencyUnavailableReason.MISSING_AUTHENTICATED_USER_ID -> IosCalendarUnavailableReason.MISSING_AUTHENTICATED_USER_ID
            CalendarDependencyUnavailableReason.INVALID_BACKEND_IDENTITY -> IosCalendarUnavailableReason.INVALID_BACKEND_IDENTITY
            CalendarDependencyUnavailableReason.PROTECTED_STORAGE -> IosCalendarUnavailableReason.PROTECTION_UNAVAILABLE
            CalendarDependencyUnavailableReason.DATABASE_OPEN -> IosCalendarUnavailableReason.DRIVER_OPEN_FAILED
            CalendarDependencyUnavailableReason.MIGRATION_FAILED -> IosCalendarUnavailableReason.MIGRATION_FAILED
            CalendarDependencyUnavailableReason.STORE_OPEN_FAILED -> IosCalendarUnavailableReason.STORE_OPEN_FAILED
            CalendarDependencyUnavailableReason.CLOSED -> IosCalendarUnavailableReason.CLOSED
        },
    )
}
