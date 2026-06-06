// ---------------------------------------------------------------------------
// SdkSessionFactory — chat-scoped SDK session factory.
//
// Builds a SentientSdk + repositories on a fresh per-screen CoroutineScope,
// wires outbox flush on READY, and exposes open()/close(). Each chat screen
// gets its own ChatSession; close() disconnects and cancels the scope.
//
// Config + bundle construction lifted from SdkHolder.buildFrom/bundle.
// SdkHolder remains in parallel until Task 3.6 completes its deletion.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.ResolvedBackend
import io.sentient.android.backend.resolveBackend
import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobiledata.repository.ConnectionRepository
import io.sentient.mobiledata.repository.HistoryRepository
import io.sentient.mobiledata.repository.SessionRowData
import io.sentient.mobilesdk.sdk.SdkConfig
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.sdk.createPlatformBundle
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlin.random.Random

/** Page size for the session list fetch. Mirrors HistoryViewModel's LIST_PAGE_LIMIT (50). */
private const val HISTORY_PAGE_LIMIT = 50

/**
 * A single chat screen's SDK session: SDK + repositories on a per-screen scope.
 *
 * Lifecycle:
 *   open()  — suspends until READY; call in background from ChatViewModel.init.
 *   close() — idle/screen-exit disconnect; keeps the session for resume (clearSession=false).
 *             Cancels the coroutine scope, stopping all collectors.
 */
class ChatSession(
    val sdk: SentientSdk,
    val chatRepo: ChatRepository,
    val connectionRepo: ConnectionRepository,
    val historyRepo: HistoryRepository,
    private val scope: CoroutineScope,
) {
    suspend fun open() { sdk.connect() }

    /**
     * Background-entry disconnect: drops the WS to save battery/radio but keeps
     * the coroutine scope + session alive so [resume] can reconnect via session-resume
     * on foreground. Does NOT cancel the scope — only [close] does that.
     */
    fun pause() { sdk.disconnect(clearSession = false) }

    /**
     * Foreground-entry reconnect: re-arms the reconnect controller and drives a
     * fresh recovery loop via [SentientSdk.forceReconnect]. Idempotent — a no-op
     * while a reconnect loop is already in flight.
     */
    suspend fun resume() { sdk.forceReconnect() }

    fun close() {
        // Screen-exit teardown: disconnect + cancel scope. Full lifecycle end.
        sdk.disconnect(clearSession = false)
        scope.cancel()
    }
}

/**
 * Factory for [ChatSession]. Each call produces a new scope-isolated session;
 * no state is shared between calls.
 *
 * Requirements:
 *  - [MobileSdk.initAndroid] MUST have been called (Application.onCreate) before
 *    the first [create] — createPlatformBundle() reads the Android Context from
 *    AndroidContextHolder (same requirement as SdkHolder).
 *  - A configured backend MUST be available (resolve returns [ResolvedBackend.Configured]).
 *    Callers should check [SdkHolder.isConfigured] before navigating to the chat screen.
 */
object SdkSessionFactory {
    fun create(): ChatSession {
        // Per-session scope: SupervisorJob so one failing child loop never cancels
        // the SDK's other coroutines. limitedParallelism(1) matches SdkHolder's
        // confinement policy — connectors + AudioPipeline assume single-threaded access.
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
            capabilities = SdkHolder.capabilities,
            devFaultsEnabled = io.sentient.android.BuildConfig.DEBUG,
        )

        // createPlatformBundle() resolves the Android Context via AndroidContextHolder;
        // a fresh instance per session so each session owns its own adapters.
        val bundle = createPlatformBundle()

        val sdk = SentientSdk(config = config, bundle = bundle, scope = scope)

        val chatRepo = ChatRepository(
            events = sdk.events,
            timeline = sdk.timeline,
            scope = scope,
            send = { text, pendingId -> sdk.sendText(text, pendingId) },
            newId = { Random.nextLong().toString(16) },
        )
        val connectionRepo = ConnectionRepository(connection = sdk.connection)
        val historyRepo = HistoryRepository(fetch = {
            val page = sdk.listSessions(limit = HISTORY_PAGE_LIMIT, offset = 0)
            page.items.map { row ->
                SessionRowData(
                    id = row.sessionId,
                    title = row.title,
                    updatedAtMs = row.lastActiveAt,
                )
            }
        })

        // Forward every connection-state emission to the repo so setConnected
        // flushes the outbox on READY and clears it on disconnect.
        scope.launch {
            sdk.connection.collect { chatRepo.setConnected(it.status == SdkStatus.READY) }
        }

        return ChatSession(sdk, chatRepo, connectionRepo, historyRepo, scope)
    }
}
