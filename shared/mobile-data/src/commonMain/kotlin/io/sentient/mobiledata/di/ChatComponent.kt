package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.SdkConnectionStateRepository
import io.sentient.mobiledata.data.SdkConversationRepository
import io.sentient.mobiledata.data.SdkSessionsRepository
import io.sentient.mobiledata.usecase.DeleteSessionUseCase
import io.sentient.mobiledata.usecase.ObserveChatUseCase
import io.sentient.mobiledata.usecase.ObserveSessionsUseCase
import io.sentient.mobiledata.usecase.RenameSessionUseCase
import io.sentient.mobiledata.usecase.SendMessageUseCase
import io.sentient.mobiledata.usecase.SwitchConversationUseCase
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import kotlin.time.Clock as KtClock

/**
 * User/Connection-scoped component: one per logged-in user. Builds the stateless repos +
 * usecases over a single [SentientSdk]. Platform DI (Hilt / UserSession) owns the instance;
 * the chat VM resolves usecases from here, never the SDK directly.
 */
class ChatComponent(
    private val sdk: SentientSdk,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    private val conversation = SdkConversationRepository(sdk)
    private val sessions = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    val observeChat = ObserveChatUseCase(conversation, clock)
    val switchConversation = SwitchConversationUseCase(sessions)
    val sendMessage = SendMessageUseCase(conversation)
    val observeSessions = ObserveSessionsUseCase(sessions)
    val renameSession = RenameSessionUseCase(sessions)
    val deleteSession = DeleteSessionUseCase(sessions)

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

    /** Open the WS, authenticate, reach READY. Suspends until settled. */
    suspend fun connect() = sdk.connect()

    /**
     * Tear down the WS + loops. [clearSession] true clears the in-session slice
     * (logout); false keeps the user in session (idle/pause).
     */
    fun disconnect(clearSession: Boolean = true) = sdk.disconnect(clearSession)
}
