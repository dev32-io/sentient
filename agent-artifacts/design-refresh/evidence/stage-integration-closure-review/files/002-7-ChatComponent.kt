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
import io.sentient.mobilesdk.connectors.DelegationSnapshotItem
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.MicLevelEnvelope
import io.sentient.mobilesdk.voice.talk.TalkMode
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlin.concurrent.Volatile
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
open class ChatComponent(
    private val sdk: SentientSdk,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
    /**
     * Reads the user's stored audio preferences (`GET /profile/me`'s `audio`),
     * or null when unavailable. Called once per [connect] to seed the SDK.
     *
     * A lambda rather than a repository so the cross-platform wiring stays HERE
     * and each platform factory supplies only the fetch — the connection-scope
     * rule's "don't duplicate wiring per platform". Defaults to null so tests
     * and any caller that does not care keep the DEFAULT preferences.
     */
    private val loadAudioPreferences: (suspend () -> AudioPreferences?)? = null,
) {
    private val disconnectLifecycle = AsyncDisconnectLifecycle { clearSession ->
        sdk.disconnect(clearSession)
    }
    // VM-facing repos are the pure SDK passthroughs: data in, data out, no accumulated
    // state. The active conversation is anchored by the SDK ([currentSessionId]); the
    // timeline is the SDK's in-memory fused stream — no client-side cache or anchor seam.
    val conversationRepository: ConversationRepository = SdkConversationRepository(sdk)
    val sessionsRepository: SessionsRepository = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    /** The gateway-minted active session id, from the SDK's session.created/switched anchor. */
    val currentSessionId: StateFlow<String?> get() = sdk.currentSessionId

    /** Talk mode (Idle | Hold | Continuous), owned by the SDK's TalkModeController. Thin
     *  passthrough mirroring [currentSessionId] — a single StateFlow with no combine/mapping
     *  needed, so it skips a dedicated repository. Consumed by the chat VMs' keep-screen-on
     *  derivation (Continuous ⇒ hands-free, no touch keeping the device awake). */
    val talkMode: StateFlow<TalkMode> get() = sdk.talkMode

    /** Native-facing aggregate mic signal; PCM remains inside the SDK uplink path. */
    val micLevels: StateFlow<MicLevelEnvelope> get() = sdk.micLevels

    /**
     * One-shot notice stream: emits [Unit] whenever the SDK fires [SdkEvent.ReopenFailed]
     * (a reconnect re-establish was rejected — the owned conversation was dropped).
     * The VM collects this in its scope and folds the event into its UI state as a
     * transient notice. Thin passthrough only: no buffering, no accumulation.
     */
    val reopenFailed: Flow<Unit>
        get() = conversationRepository.liveEvents
            .filterIsInstance<SdkEvent.ReopenFailed>()
            .map { }

    /**
     * Open L3 permission prompts (design §7.1) — the DI seam both platform ViewModels
     * wrap. Continuous state, so a StateFlow: every value carries every still-open
     * prompt, which makes conflation harmless. Thin passthrough, no accumulation.
     */
    val permissions: StateFlow<List<PermissionPrompt>> get() = sdk.permissions

    /** Live background-delegation rows (design §5.4). Thin passthrough. */
    val delegations: StateFlow<List<DelegationSnapshotItem>> get() = sdk.delegations

    /**
     * One-shot prompt arrivals off the SDK's NO-LOSS event stream. A VM that renders
     * dialogs from a queue collects this; a VM that renders "the current prompt" reads
     * [permissions]. Never fold a request away — a dropped prompt blocks a turn until
     * the gateway's 2-minute timeout denies it.
     */
    val permissionRequests: Flow<PermissionPrompt>
        get() = conversationRepository.liveEvents
            .filterIsInstance<SdkEvent.PermissionRequested>()
            .map { it.prompt }

    /** One-shot resolutions (allowed | denied | timeout) — the dismiss signal. */
    val permissionResolutions: Flow<SdkEvent.PermissionResolved>
        get() = conversationRepository.liveEvents.filterIsInstance<SdkEvent.PermissionResolved>()

    /** The user's Allow / Deny. Fail-closed: silence is never approval (§7.1). */
    fun respondToPermission(requestId: String, approved: Boolean) = sdk.respondToPermission(requestId, approved)

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

    // ── Talk-mode intents (design spec §3) ────────────────────────────────────
    // The corner-mic gesture layer emits ONLY these four; all mode semantics live in the
    // SDK's TalkModeController. Thin passthroughs, mirroring the SDK's intent surface.

    /** Idle → Hold: press-to-talk begins. */
    fun pressMic() = sdk.pressMic()

    /** Hold → Idle: release finalizes the manual turn. */
    fun releaseMic() = sdk.releaseMic()

    /** Hold → Continuous: slide-to-lock (manual segment finalizes, semantic turn opens). */
    fun lockMic() = sdk.lockMic()

    /** Continuous → Idle: tap-to-stop hands-free. */
    fun stopContinuous() = sdk.stopContinuous()

    // iOS VoiceCaptureControl intent vocabulary. Screens never construct wire frames.
    fun holdStart() = sdk.holdStart()
    fun sendHeld() = sdk.sendHeld()
    fun cancelHeld() = sdk.cancelHeld()
    fun enterAuto() = sdk.enterAuto()
    fun exitAuto() = sdk.exitAuto()
    fun lifecycleCancel() = sdk.lifecycleCancel()

    /** Patch TTS on/off; the gateway echoes the change via session preferences. */
    suspend fun setTtsEnabled(enabled: Boolean) = sdk.setTtsEnabled(enabled)

    /**
     * Patch audio output preferences (TTS on/off and/or reply channel) live over the WS.
     * The connection-scope handle the settings layer binds as its `liveAudioPatch` so an Audio
     * fast-save reflects on the running session with no restart. Superset of [setTtsEnabled].
     */
    suspend fun patchAudioPreferences(patch: AudioPreferencesPatch) = sdk.patchAudioPreferences(patch)

    /** UI Stop — idempotent hard interrupt of the active turn + audio. */
    fun interrupt() = sdk.interrupt()

    /** Manual reconnect — re-arm the reconnect controller and drive recovery. */
    fun forceReconnect() = sdk.forceReconnect()

    /**
     * Engagement-driven connectivity check — call from every "user is at the chat"
     * signal: screen entry, ON_RESUME, composer focus, pre-send.
     * READY → liveness probe; not-READY → forceReconnect (re-establishes anchored
     * conversation via conversation.activate on the next READY rising edge).
     */
    fun ensureConnected() = sdk.ensureConnected()

    /** Foreground presence — one-shot liveness probe; reconnect only if the socket is dead. */
    fun onForeground() = sdk.onForeground()

    /**
     * Open the WS, authenticate, reach READY. Suspends until settled.
     *
     * Seeds the SDK's audio preferences first, so the chat TTS toggle renders
     * the user's STORED value rather than [AudioPreferences.DEFAULT]. The
     * gateway sends no preferences frame at `session.configure`, so without
     * this the client shows TTS on for a user who turned it off — and every tap
     * then derives the next value from that wrong baseline.
     *
     * Best-effort and never fatal: a failed or absent read leaves the defaults
     * and connect proceeds. A preference is not worth blocking the socket for.
     */
    suspend fun connect() {
        seedAudioPreferences()
        sdk.connect()
    }

    private suspend fun seedAudioPreferences() {
        val load = loadAudioPreferences ?: return
        val prefs = runCatching { load() }.getOrNull() ?: return
        sdk.seedAudioPreferences(prefs)
    }

    /**
     * Tear down the WS + loops. [clearSession] true clears the in-session slice
     * (logout); false keeps the user in session (idle/pause).
     */
    // Preserve the platform-facing synchronous callback contract without parking its caller.
    // The SDK's bounded ordered fence runs on this component-owned non-main lifecycle, which
    // survives the platform owner cancelling its ordinary session scope immediately afterward.
    fun disconnect(clearSession: Boolean = true) {
        disconnectLifecycle.disconnect(clearSession)
    }

    /**
     * Connection-scope teardown (logout). No-op today — the SDK + its scope are owned
     * by the platform layer, and there is no durable store to release. Kept as the
     * stable platform-facing teardown hook (call after [disconnect]); idempotent.
     */
    fun close() {
        disconnectLifecycle.closeAfterDisconnect()
    }
}

/** Structured fire-and-finish lifecycle for the platform's synchronous logout callback. */
internal class AsyncDisconnectLifecycle(
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val teardown: suspend (Boolean) -> Unit,
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    @Volatile private var closeRequested = false
    @Volatile private var teardownJob: Job? = null

    fun disconnect(clearSession: Boolean) {
        if (teardownJob?.isActive == true) return
        teardownJob = scope.launch {
            try {
                teardown(clearSession)
            } finally {
                if (closeRequested) scope.cancel()
            }
        }
    }

    fun closeAfterDisconnect() {
        closeRequested = true
        if (teardownJob?.isActive != true) scope.cancel()
    }
}
