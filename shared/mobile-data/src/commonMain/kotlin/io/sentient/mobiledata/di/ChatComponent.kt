package io.sentient.mobiledata.di

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.data.SdkConnectionStateRepository
import io.sentient.mobiledata.data.SdkConversationRepository
import io.sentient.mobiledata.data.SdkSessionsRepository
import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobiledata.draft.NativeDraft
import io.sentient.mobiledata.draft.NativeDraftCoordinator
import io.sentient.mobiledata.draft.NativePendingSend
import io.sentient.mobiledata.draft.NativeSendAnchorUnavailableException
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobiledata.usecase.ActivateSessionUseCase
import io.sentient.mobiledata.usecase.DeleteSessionUseCase
import io.sentient.mobiledata.usecase.ObserveChatUseCase
import io.sentient.mobiledata.usecase.ObserveSessionsUseCase
import io.sentient.mobiledata.usecase.RenameSessionUseCase
import io.sentient.mobiledata.usecase.SendMessageUseCase
import io.sentient.mobiledata.usecase.SwitchConversationUseCase
import io.sentient.mobilesdk.attachments.AttachmentRef
import io.sentient.mobilesdk.attachments.AttachmentRequestException
import io.sentient.mobilesdk.attachments.AttachmentsHttpClient
import io.sentient.mobilesdk.connectors.DelegationSnapshotItem
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.connectors.SessionsChangeEvent
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTransportException
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.MicLevelEnvelope
import io.sentient.mobilesdk.voice.talk.TalkMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.concurrent.Volatile
import kotlin.time.Clock as KtClock

private sealed interface DraftAnchorWait {
    data object Waiting : DraftAnchorWait
    data object Invalidated : DraftAnchorWait
    data class Ready(val mintKey: String) : DraftAnchorWait
}

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
    /** Protected account+gateway local draft state; absent only when platform storage failed. */
    val drafts: NativeDraftCoordinator? = null,
    private val attachments: AttachmentsHttpClient? = null,
    private val attachmentBody: ((String) -> io.sentient.mobilesdk.attachments.AttachmentUploadBody)? = null,
    private val attachmentDownload: (suspend (String, String) -> String)? = null,
    private val removeAttachmentDownload: ((String) -> Unit)? = null,
    private val closeAttachmentDownloads: (() -> Unit)? = null,
) {
    private val disconnectLifecycle = AsyncDisconnectLifecycle { clearSession ->
        sdk.disconnect(clearSession)
    }
    private val componentScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val _sessionChanges = MutableSharedFlow<SessionsChangeEvent>()
    val sessionChanges: SharedFlow<SessionsChangeEvent> = _sessionChanges.asSharedFlow()

    init {
        componentScope.launch {
            sdk.sessionChanges.collect { event ->
                if (event is SessionsChangeEvent.Deleted) drafts?.detachDeletedSession(event.sessionId)
                _sessionChanges.emit(event)
            }
        }
    }
    // VM-facing repos are the pure SDK passthroughs: data in, data out, no accumulated
    // state. The active conversation is anchored by the SDK ([currentSessionId]); the
    // timeline is the SDK's in-memory fused stream — no client-side cache or anchor seam.
    val conversationRepository: ConversationRepository = SdkConversationRepository(sdk)
    val sessionsRepository: SessionsRepository = SdkSessionsRepository(sdk)
    val connection = SdkConnectionStateRepository(sdk)

    /** Durable gateway-minted anchor, retained across reconnect. */
    val currentSessionId: StateFlow<String?> get() = sdk.currentSessionId

    /** Session authorized for outbound messages on the current transport. */
    val outboundSessionId: StateFlow<String?> get() = sdk.outboundSessionId

    /** Local route-instance authority; changes even when navigation returns to the same session. */
    val outboundRouteGeneration: StateFlow<Long?> get() = sdk.outboundRouteGeneration

    /** Durable acknowledged identity, retained across transport loss. */
    val acknowledgedRoute get() = sdk.acknowledgedRoute

    /** VM-scoped automatic outbox drain, shared by Android and iOS. */
    fun observeOutbound(cache: OutboundCache): Flow<Unit> = sendMessage.observeReadiness(cache, connection.state)

    /** Read current SDK status, never a lagging native UI projection. */
    fun flushOutbound(cache: OutboundCache) = sendMessage.flushIfReady(cache, connection.state.value.status)

    /** Move active editor onto gateway's post-delete draft route after dropping old sends. */
    fun rebindAfterRemoteDelete(cache: OutboundCache) {
        cache.dropPending()
        outboundRouteGeneration.value?.let(cache::rebindToRoute)
    }

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

    val observeChat = ObserveChatUseCase(
        conversationRepository,
        clock,
        sdk.assistantActivity,
    )
    val switchConversation = SwitchConversationUseCase(sessionsRepository)
    val sendMessage = SendMessageUseCase(conversationRepository, outboundSessionId, outboundRouteGeneration, sdk.transportGeneration)
    val observeSessions = ObserveSessionsUseCase(sessionsRepository)
    val activateSession = ActivateSessionUseCase(sessionsRepository)
    val renameSession = RenameSessionUseCase(sessionsRepository)
    val deleteSession = DeleteSessionUseCase(sessionsRepository)

    /**
     * Wait for gateway mint without entering the draft mutation barrier. Route changes cancel
     * immediately; a dead/offline gateway becomes a typed, bounded failure instead of wedging
     * local draft writes forever.
     */
    @Throws(NativeSendAnchorUnavailableException::class, CancellationException::class)
    suspend fun awaitDraftSendAnchor(expectedGeneration: Long?): String {
        val expected = expectedGeneration
            ?: throw NativeSendAnchorUnavailableException("route unavailable")
        val result = withTimeoutOrNull(DRAFT_SEND_ANCHOR_TIMEOUT_MILLIS) {
            combine(outboundRouteGeneration, outboundSessionId) { generation, mintKey ->
                when {
                    generation != expected -> DraftAnchorWait.Invalidated
                    mintKey != null -> DraftAnchorWait.Ready(mintKey)
                    else -> DraftAnchorWait.Waiting
                }
            }.first { it !is DraftAnchorWait.Waiting }
        } ?: throw NativeSendAnchorUnavailableException("outbound anchor unavailable")
        return when (result) {
            is DraftAnchorWait.Ready -> result.mintKey
            DraftAnchorWait.Invalidated -> throw CancellationException("route changed")
            DraftAnchorWait.Waiting -> error("anchor wait did not settle")
        }
    }

    /** Freeze send identity after [mintKey] was captured outside the mutation barrier. */
    @Throws(NativeSendAnchorUnavailableException::class, CancellationException::class)
    suspend fun beginDraftSend(
        draftId: String,
        mintKey: String,
        expectedGeneration: Long?,
    ): NativePendingSend {
        val coordinator = drafts
            ?: throw NativeSendAnchorUnavailableException("draft storage unavailable")
        val generation = expectedGeneration
            ?: throw NativeSendAnchorUnavailableException("route unavailable")
        if (outboundRouteGeneration.value != generation) throw CancellationException("route changed")
        return coordinator.beginSend(draftId, mintKey, sdk.surfaceId)
    }

    @Throws(AttachmentRequestException::class, CancellationException::class)
    suspend fun uploadPendingAttachments(
        pending: NativePendingSend,
        expectedRouteGeneration: Long?,
        onProgress: (String, Long, Long) -> Unit,
    ): List<AttachmentRef> = try {
        val client = attachments ?: error("attachment transport unavailable")
        val body = attachmentBody ?: error("attachment file access unavailable")
        val uploaded = mutableListOf<AttachmentRef>()
        for (file in pending.attachments) {
            if (outboundRouteGeneration.value != expectedRouteGeneration ||
                drafts?.snapshot?.value?.pendingSends?.none { it.pendingId == pending.pendingId } != false
            ) throw CancellationException("pending route changed")
            uploaded += client.upload(
                sendAttemptId = pending.pendingId,
                fileIdentity = file.id,
                displayName = file.displayName,
                contentType = file.mediaType,
                body = body(file.localPath),
            ) { sent, total -> onProgress(file.id, sent, total) }
        }
        if (outboundRouteGeneration.value != expectedRouteGeneration ||
            drafts?.snapshot?.value?.pendingSends?.none { it.pendingId == pending.pendingId } != false
        ) throw CancellationException("pending route changed")
        uploaded
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: AttachmentRequestException) {
        throw failure
    } catch (_: Throwable) {
        throw AttachmentRequestException(0, "local_file_error")
    }

    /**
     * Re-submit each frozen file identity, then delete its staged manifest. DELETE is the
     * gateway's admission fence: any ambiguous/already-committed attempt fails closed.
     */
    @Throws(AttachmentRequestException::class, CancellationException::class)
    suspend fun cancelPendingSend(pending: NativePendingSend): NativeDraft = try {
        require(pending.attachments.isNotEmpty())
        val client = attachments ?: error("attachment transport unavailable")
        val body = attachmentBody ?: error("attachment file access unavailable")
        for (file in pending.attachments) {
            val ref = client.upload(
                sendAttemptId = pending.pendingId,
                fileIdentity = file.id,
                displayName = file.displayName,
                contentType = file.mediaType,
                body = body(file.localPath),
            )
            client.delete(ref.attachmentId)
        }
        checkNotNull((drafts ?: error("draft storage unavailable")).notCommitted(pending.pendingId))
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: AttachmentRequestException) {
        throw failure
    } catch (_: Throwable) {
        throw AttachmentRequestException(0, "local_file_error")
    }

    @Throws(AttachmentRequestException::class, CancellationException::class)
    suspend fun previewAttachment(attachmentId: String): ByteArray = attachmentExport {
        (attachments ?: error("attachment transport unavailable")).preview(attachmentId)
    }

    @Throws(AttachmentRequestException::class, CancellationException::class)
    suspend fun previewDraftAttachment(attachmentId: String, maxPixelSize: Int): ByteArray? = attachmentExport {
        (drafts ?: error("draft storage unavailable")).previewAttachment(attachmentId, maxPixelSize)
    }

    @Throws(AttachmentRequestException::class, CancellationException::class)
    suspend fun downloadAttachment(attachmentId: String, displayName: String): String = attachmentExport {
        (attachmentDownload ?: error("attachment file access unavailable"))(attachmentId, displayName)
    }

    private suspend fun <T> attachmentExport(block: suspend () -> T): T = try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: AttachmentRequestException) {
        throw failure
    } catch (_: Throwable) {
        throw AttachmentRequestException(0, "local_file_error")
    }

    fun removeDownloadedAttachment(path: String) = removeAttachmentDownload?.invoke(path)

    /** Process an already-durable client delete intent and retain typed retry state. */
    suspend fun processDeleteIntent(sessionId: String) {
        val coordinator = drafts ?: return
        try {
            deleteSession(sessionId)
            coordinator.completeDelete(sessionId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: SessionsTransportException) {
            coordinator.markDeleteFailure(sessionId, "transient")
        } catch (failure: SessionsRequestException) {
            coordinator.markDeleteFailure(
                sessionId,
                if (failure.code in TRANSIENT_DELETE_CODES) "transient" else "permanent",
            )
        } catch (_: Throwable) {
            coordinator.markDeleteFailure(sessionId, "transient")
        }
    }

    /** Bind one VM-owned cache to its route request. A pre-authorized deep-link route
     * reuses the generation claimed by the awaited activation. */
    fun bindChatRoute(
        cache: OutboundCache,
        sessionId: String?,
        draftId: String? = null,
        activate: Boolean = true,
    ) {
        val pending = draftId?.let { id -> drafts?.snapshot?.value?.pendingSends?.firstOrNull { it.draftId == id } }
        val generation = when {
            pending?.sessionId != null -> sdk.beginSessionRoute(pending.sessionId)
            pending != null -> sdk.restorePendingMintAnchor(pending.mintKey, pending.surfaceId)
            activate && sessionId == null -> sdk.beginFreshChatRoute()
            activate && sessionId != null -> sdk.beginSessionRoute(sessionId)
            sessionId != null && acknowledgedRoute.value?.sessionId == sessionId &&
                acknowledgedRoute.value?.generation == outboundRouteGeneration.value -> acknowledgedRoute.value?.generation
            else -> null
        }
        if (generation != null) cache.bindToRoute(generation)
    }

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
        drafts?.restore()
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
        componentScope.cancel()
        closeAttachmentDownloads?.invoke()
        attachments?.close()
        disconnectLifecycle.closeAfterDisconnect()
    }

    private companion object {
        const val DRAFT_SEND_ANCHOR_TIMEOUT_MILLIS = 2_000L
        val TRANSIENT_DELETE_CODES = setOf(
            "unavailable", "internal", "provider_unavailable", "unauthorized", "expired", "auth-required",
        )
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
