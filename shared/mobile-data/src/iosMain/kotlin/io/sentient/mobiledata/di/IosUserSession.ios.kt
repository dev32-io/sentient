// ---------------------------------------------------------------------------
// IosUserSession — the User/Connection scope for iOS (SKIE-exposed to Swift).
//
// Mirrors the Android UserSessionManager: models the "logged-in user" by owning
// ONE ChatComponent (+ its SentientSdk + a session CoroutineScope), built once
// for the duration of a login. The same authenticated scope owns one calendar
// database/cache/experience, which lives above NavigationStack route recreation.
//
// Lifecycle:
//   - open()   — background connect(); the UI never blocks on it.
//   - pause()  — app background: KEEP the socket.
//   - resume() — app foreground: one-shot liveness probe / reconnect.
//   - close()  — logout/auth expiry: calendar observation is cancelled first,
//                the current namespace is purged in a bounded NonCancellable
//                context, then the protected driver and session are closed.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.di

import io.sentient.mobiledata.cache.CalendarCacheNamespace
import io.sentient.mobiledata.cache.CalendarCacheResult
import io.sentient.mobiledata.cache.CalendarCacheStore
import io.sentient.mobiledata.cache.createCalendarCacheStore
import io.sentient.mobiledata.cache.db.openCalendarDatabase
import io.sentient.mobiledata.calendar.CalendarExperience
import io.sentient.mobiledata.calendar.createCalendarExperience
import io.sentient.mobiledata.data.calendar.CalendarRepository
import io.sentient.mobiledata.data.calendar.SdkCalendarRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarEventPage
import io.sentient.mobilesdk.calendar.CalendarHttpClient
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.Importance
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

private const val IOS_CALENDAR_TEARDOWN_TIMEOUT_MILLIS = 2_000L
private const val IOS_INVALID_GATEWAY_WS_URL = "ws://invalid.invalid/api/v1/ws"

private fun safeIosGatewayWsUrl(gatewayWsUrl: String): String = try {
    normalizeIosBackendIdentity(gatewayWsUrl)
    gatewayWsUrl
} catch (_: Throwable) {
    IOS_INVALID_GATEWAY_WS_URL
}

/**
 * One calendar boundary inside an authenticated iOS session. The runtime owns
 * the store and experience together so a failed construction can close every
 * already-open resource without exposing a partial object to Swift.
 */
private class IosCalendarRuntime(
    val namespace: CalendarCacheNamespace,
    private val cacheStore: CalendarCacheStore,
    val experience: CalendarExperience,
) {
    private var disposed = false

    suspend fun disposeAndPurge(): CalendarCacheResult<Unit> {
        if (disposed) return CalendarCacheResult.Success(Unit)
        disposed = true
        return experience.disposeAndPurge()
    }

    fun forceClose() {
        // This path is also used after a timed-out purge. It must close the
        // driver even though disposeAndPurge may already have marked itself.
        disposed = true
        experience.close()
        cacheStore.close()
    }
}

private data class IosCalendarSetup(
    val runtime: IosCalendarRuntime?,
    val repository: CalendarRepository,
    val availability: IosCalendarAvailability,
)

/** A fail-closed repository used when protected calendar storage is unavailable. */
private class UnavailableCalendarRepository : CalendarRepository {
    private fun <T : Any> failure(): SentientResult<T> = SentientResult.Failure(
        SentientError.Protocol("Calendar storage is unavailable."),
    )

    override suspend fun get(id: String, originalStart: String?, scope: CalendarScope?): SentientResult<CalendarEvent> = failure()

    override suspend fun list(
        from: String,
        to: String,
        scope: CalendarScope?,
        group: String?,
        tags: List<String>?,
        importance: Importance?,
        cursor: String?,
        query: String?,
        limit: Int?,
    ): SentientResult<CalendarEventPage> = failure()

    override suspend fun create(event: CalendarEvent): SentientResult<CalendarEvent> = failure()

    override suspend fun create(input: CalendarCreateInput): SentientResult<CalendarEvent> = failure()

    override suspend fun mutate(
        eventId: String,
        command: CalendarMutationCommand,
    ): SentientResult<CalendarMutationResult> = failure()
}

/**
 * One per logged-in user. Holds the SDK + ChatComponent + settings + the
 * session-scoped calendar experience. [authenticatedUserId] is supplied by the
 * server-authenticated login response; it is never inferred from display name
 * or token text.
 */
class IosUserSession(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    authenticatedUserId: String,
    capabilities: List<String> = emptyList(),
    devFaultsEnabled: Boolean = false,
    /** Clear-local-session hook for settings Account logout. */
    onLoggedOut: () -> Unit = {},
) {
    private val log = createLogger("data", "ios-user-session")
    private val userId = authenticatedUserId.trim()
    // Existing HTTP/WS factories log the configured endpoint structurally. Do
    // not pass an endpoint containing userinfo/query/fragment material into
    // them; calendar setup retains the original only to classify it unavailable.
    private val safeGatewayWsUrl = safeIosGatewayWsUrl(gatewayWsUrl)
    private var closed = false

    // Last-resort guard for an uncaught throw on a connection-scope coroutine.
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

    // Calendar work intentionally has a separate lifetime from the SDK scope.
    // close() must keep this scope alive while its NonCancellable purge finishes;
    // cancelling the authenticated SDK scope first would cancel the purge too.
    private val calendarScope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default.limitedParallelism(1))

    // Build the platform bundle once so the token store is shared between the SDK
    // WS transport and both REST clients (same Keychain item).
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

    // Settings and calendar share one configured Darwin HTTP client. The
    // repository remains stateless; only the experience owns cache policy.
    private val settingsHttpClient = createSettingsHttpClient(allowSelfSignedDevHost)
    private val remoteCalendarRepository: CalendarRepository = SdkCalendarRepository(
        CalendarHttpClient(
            settingsHttpClient,
            safeGatewayWsUrl,
            { bundle.tokenStore.load() ?: "" },
        ),
    )
    private val calendarSetup: IosCalendarSetup = buildCalendarSetup(
        repository = remoteCalendarRepository,
        userId = userId,
        gatewayWsUrl = gatewayWsUrl,
        scope = calendarScope,
    )

    /**
     * Settings slice of this connection scope. When protected calendar storage
     * fails, its calendar repository is fail-closed and no remote calendar rows
     * are exposed through the legacy use-case surface.
     */
    val settings: SettingsComponent = SettingsComponent(
        httpClient = settingsHttpClient,
        gatewayWsUrl = safeGatewayWsUrl,
        token = { bundle.tokenStore.load() ?: "" },
        liveAudioPatch = component::patchAudioPreferences,
        onTokenRefreshed = { bundle.tokenStore.save(it) },
        onLoggedOut = onLoggedOut,
        calendarExperience = calendarSetup.runtime?.experience,
        injectedCalendarRepository = calendarSetup.repository,
    )

    /** Explicit identity retained by this authenticated boundary. */
    val authenticatedUserId: String get() = userId

    /** One shared calendar experience for the authenticated lifetime, if available. */
    val calendarExperience: CalendarExperience? get() = calendarSetup.runtime?.experience

    /** Typed fail-closed state for protected calendar storage. */
    val calendarAvailability: IosCalendarAvailability get() = calendarSetup.availability

    /** Namespace used by the cache, exposed for SKIE/native lifecycle tests. */
    val calendarNamespace: CalendarCacheNamespace? get() = calendarSetup.runtime?.namespace

    /** Background connect: UI is usable immediately; reconnect is owned by the SDK. */
    fun open() {
        scope.launch {
            try {
                component.connect()
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

    /** App background → keep the authenticated socket. */
    fun pause() {
        // Do not drop the socket on background; resume/ensureConnected verifies it.
    }

    /** App foreground → one-shot liveness probe/reconnect primitive. */
    fun resume() {
        sdk.onForeground()
    }

    /**
     * Logout/auth-expiry teardown. The calendar experience cancels its
     * observation and prefetch work, then purges the active namespace in a
     * bounded NonCancellable context before closing its driver. Only after that
     * does the SDK scope close, so a successor session cannot race the purge.
     */
    fun close() {
        if (closed) return
        closed = true

        val runtime = calendarSetup.runtime
        if (runtime != null) {
            runBlocking(Dispatchers.Default) {
                try {
                    withContext(NonCancellable) {
                        withTimeout(IOS_CALENDAR_TEARDOWN_TIMEOUT_MILLIS) {
                            val result = runtime.disposeAndPurge()
                            if (result is CalendarCacheResult.Failure) {
                                log.warn(
                                    "calendar.purge-failed",
                                    mapOf("reason" to result.error.reason.name),
                                )
                            }
                        }
                    }
                } catch (_: Throwable) {
                    // A timeout or driver failure still fails closed: invalidate
                    // the experience and close the store rather than retaining
                    // readable rows after logout.
                    runtime.forceClose()
                    log.warn("calendar.close-failed", mapOf("reason" to "bounded-teardown"))
                }
            }
        }

        sdk.disconnect(clearSession = true)
        component.close()
        calendarScope.cancel()
        scope.cancel()
        settingsHttpClient.close()
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

private fun buildCalendarSetup(
    repository: CalendarRepository,
    userId: String,
    gatewayWsUrl: String,
    scope: CoroutineScope,
): IosCalendarSetup {
    val namespace = try {
        iosCalendarNamespace(userId, gatewayWsUrl)
    } catch (failure: IosCalendarDatabaseFailure) {
        return unavailableCalendarSetup(failure.reason)
    } catch (_: Throwable) {
        return unavailableCalendarSetup(IosCalendarUnavailableReason.INVALID_BACKEND_IDENTITY)
    }

    var handle: io.sentient.mobiledata.cache.db.CalendarDatabaseHandle? = null
    var cacheStore: CalendarCacheStore? = null
    var experience: CalendarExperience? = null
    return try {
        handle = openCalendarDatabase(IosCalendarDatabaseDriverFactory())
        cacheStore = createCalendarCacheStore(
            handle = handle,
            namespace = namespace,
            observationContext = Dispatchers.Default,
        )
        experience = createCalendarExperience(
            repository = repository,
            cacheStore = cacheStore,
            scope = scope,
        )
        IosCalendarSetup(
            runtime = IosCalendarRuntime(namespace, cacheStore, experience),
            repository = repository,
            availability = IosCalendarAvailability.available(),
        )
    } catch (failure: IosCalendarDatabaseFailure) {
        experience?.close()
        cacheStore?.close()
        handle?.close()
        unavailableCalendarSetup(failure.reason)
    } catch (_: Throwable) {
        experience?.close()
        cacheStore?.close()
        handle?.close()
        unavailableCalendarSetup(IosCalendarUnavailableReason.STORE_OPEN_FAILED)
    }
}

private fun unavailableCalendarSetup(
    reason: IosCalendarUnavailableReason,
): IosCalendarSetup = IosCalendarSetup(
    runtime = null,
    repository = UnavailableCalendarRepository(),
    availability = IosCalendarAvailability.unavailable(reason),
)
