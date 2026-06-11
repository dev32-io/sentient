package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.data.SdkConnectionStateRepository
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
import kotlinx.coroutines.flow.StateFlow
import kotlin.time.Clock as KtClock

/**
 * User/Connection-scoped component: one per logged-in user. Builds the stateless repos +
 * usecases over a single [SentientSdk]. Platform DI (Hilt / UserSession) owns the instance;
 * the chat VM resolves usecases from here, never the SDK directly.
 *
 * The chat timeline is IN-MEMORY: it comes straight from the SDK's fused [SentientSdk.timeline]
 * (REST history replace + live appends), anchored by the SDK's own [SentientSdk.currentSessionId].
 * There is NO durable client store — history is re-fetched from the gateway/Hermes on attach.
 */
class ChatComponent(
    private val sdk: SentientSdk,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    // VM-facing repos are the pure SDK passthroughs: data in, data out, no accumulated
    // state. The active conversation is anchored by the SDK ([currentSessionId]); the
    // timeline is the SDK's in-memory fused stream — no client-side cache or anchor seam.
    val conversationRepository: ConversationRepository = SdkConversationRepository(sdk)
    val sessionsRepository: SessionsRepository = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    /** The gateway-minted active session id, from the SDK's session.created/switched anchor. */
    val currentSessionId: StateFlow<String?> get() = sdk.currentSessionId

    val observeChat = ObserveChatUseCase(conversationRepository, clock)
    val switchConversation = SwitchConversationUseCase(sessionsRepository)
    val sendMessage = SendMessageUseCase(conversationRepository, currentSessionId)
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
     * Connection-scope teardown (logout). No-op today — the SDK + its scope are owned
     * by the platform layer, and there is no durable store to release. Kept as the
     * stable platform-facing teardown hook (call after [disconnect]); idempotent.
     */
    fun close() {
        // Nothing client-scoped to release: the timeline is in-memory in the SDK.
    }
}
