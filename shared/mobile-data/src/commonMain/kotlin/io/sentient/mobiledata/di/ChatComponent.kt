package io.sentient.mobiledata.di

import io.sentient.mobiledata.cache.db.ChatDatabase
import io.sentient.mobiledata.cache.db.DatabaseDriverFactory
import io.sentient.mobiledata.data.CachingConversationRepository
import io.sentient.mobiledata.data.CachingSessionsRepository
import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.data.SdkConnectionStateRepository
import io.sentient.mobiledata.data.ioDispatcher
import io.sentient.mobiledata.data.SdkConversationRepository
import io.sentient.mobiledata.data.SdkSessionsRepository
import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobiledata.usecase.DeleteSessionUseCase
import io.sentient.mobiledata.usecase.ObserveChatUseCase
import io.sentient.mobiledata.usecase.ObserveSessionsUseCase
import io.sentient.mobiledata.usecase.RenameSessionUseCase
import io.sentient.mobiledata.usecase.SendMessageUseCase
import io.sentient.mobiledata.usecase.SwitchConversationUseCase
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlin.time.Clock as KtClock

/**
 * User/Connection-scoped component: one per logged-in user. Builds the stateless repos +
 * usecases over a single [SentientSdk]. Platform DI (Hilt / UserSession) owns the instance;
 * the chat VM resolves usecases from here, never the SDK directly.
 *
 * @param databaseDriverFactory The platform SQL driver factory for the device chat mirror
 *   (Slice 4.5/4.6 consume it).
 */
class ChatComponent(
    private val sdk: SentientSdk,
    private val databaseDriverFactory: DatabaseDriverFactory,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    // Connection-scoped scope for the durable chat mirror's write-through + DB-backed
    // timeline collectors. Lives as long as this user component; the platform owner
    // tears the component down on logout, which cancels these collectors.
    private val mirrorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // One SQL driver + ChatDatabase per connection scope (the driver factory opens +
    // migrates the schema; we wrap it once here and inject the DB into the caching
    // decorator). The driver is released in [close] on logout.
    private val driver = databaseDriverFactory.create()
    private val database = ChatDatabase(driver)

    // Platform IO dispatcher for the caching decorator's blocking SQLite writes, so
    // they never run on the mirrorScope's CPU (Dispatchers.Default) pool. Android →
    // real Dispatchers.IO; iOS → a dedicated DB-writer thread (see [ioDispatcher]).
    //
    // ACTIVATION (Task 4.7): the usecases the ViewModels consume are built over the
    // CACHING decorators, NOT the raw SDK repos — so opening the app paints the last
    // conversation's transcript + session list from the local DB instantly, with the
    // REST/SDK refresh layered on. The raw SdkConversationRepository / SdkSessionsRepository
    // survive ONLY as the decorators' underlying passthrough. Exposed (read-only) so the
    // wiring is unit-testable: the VM-facing repos ARE the Caching types.
    val conversationRepository: ConversationRepository =
        CachingConversationRepository(
            SdkConversationRepository(sdk),
            database,
            mirrorScope,
            ioDispatcher = ioDispatcher(),
        )
    // Same ChatDatabase + mirrorScope + ioDispatcher as the conversation decorator —
    // one durable cache, one connection scope. Serves the session list from the DB for
    // instant paint and runs the smart-async deletion of locally-stale sessions on
    // refresh. Wraps the pure REST repo, which still exists underneath.
    val sessionsRepository: SessionsRepository =
        CachingSessionsRepository(
            SdkSessionsRepository(sdk),
            database,
            mirrorScope,
            ioDispatcher = ioDispatcher(),
        )
    val connection = SdkConnectionStateRepository(sdk)

    val observeChat = ObserveChatUseCase(conversationRepository, clock)
    val switchConversation = SwitchConversationUseCase(sessionsRepository)
    val sendMessage = SendMessageUseCase(conversationRepository)
    val observeSessions = ObserveSessionsUseCase(sessionsRepository)
    val renameSession = RenameSessionUseCase(sessionsRepository)
    val deleteSession = DeleteSessionUseCase(sessionsRepository)

    // ── SDK UI-command passthroughs ───────────────────────────────────────────
    // The chat VM drives voice / TTS / interrupt / reconnect + lifecycle through
    // these thin delegates so it never holds an SDK reference. Mirrors the surface
    // the old ChatRoot/ChatContent called on `sdk` directly.

    /** Start the voice uplink (mic ON). */
    fun startMic() = sdk.startMic()

    /** Stop the voice uplink (mic OFF). */
    fun stopMic() = sdk.stopMic()

    /** Patch TTS on/off; the gateway echoes the change via session preferences. */
    suspend fun setTtsEnabled(enabled: Boolean) = sdk.setTtsEnabled(enabled)

    /** UI Stop — idempotent hard interrupt of the active cycle + audio. */
    fun interrupt() = sdk.interrupt()

    /** Manual reconnect — re-arm the reconnect controller and drive recovery. */
    fun forceReconnect() = sdk.forceReconnect()

    /** Foreground presence — one-shot liveness probe; reconnect only if the socket is dead. */
    fun onForeground() = sdk.onForeground()

    /** Open the WS, authenticate, reach READY. Suspends until settled. */
    suspend fun connect() = sdk.connect()

    /**
     * Tear down the WS + loops. [clearSession] true clears the in-session slice
     * (logout); false keeps the user in session (idle/pause).
     */
    fun disconnect(clearSession: Boolean = true) = sdk.disconnect(clearSession)

    /**
     * Connection-scope teardown (logout): cancel the chat-mirror collectors and
     * release the SQL driver. Call after [disconnect]. Idempotent at the platform
     * layer (the component is nulled and rebuilt on the next login).
     */
    fun close() {
        mirrorScope.cancel()
        driver.close()
    }
}
