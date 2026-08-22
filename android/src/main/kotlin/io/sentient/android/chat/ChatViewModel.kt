// ---------------------------------------------------------------------------
// ChatViewModel — thin per-conversation state holder over the shared usecase layer.
//
// Receives the User/Connection-scoped ChatComponent directly (DI resolves it from
// UserSessionManager in production; tests inject a fake subclass). Never holds the
// SDK directly. On init it switches the active conversation to the route's sessionId
// (null = new chat), then folds observeChat(cache.pending) → ChatUiState.
// The optimistic outbox (OutboundCache) is per-conversation: it lives and dies with
// this VM, so switching conversation = navigating = a fresh VM = clean state.
//
// Lifecycle (open/close/pause/resume) is owned by UserSessionManager, NOT here — a
// VM teardown on conversation switch must NOT disconnect the SDK.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.ChatComponent
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.voice.io.MicLevelEnvelope
import io.sentient.mobilesdk.voice.talk.TalkMode
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

class ChatViewModel(
    private val component: ChatComponent,
    sessionId: String?,
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val cache = OutboundCache()

    /** The active local-timeout-fallback job (see [armLocalTimeoutFallback]), or null.
     *  Re-armed per prompt; cancelled the instant a newer emission or a user
     *  response supersedes it. */
    private var permissionTimeoutJob: Job? = null

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    /** Transport + voice axis. Latest-wins StateFlow for the connection banner + composer. */
    val connection: StateFlow<ConnectionState> = component.connection.state
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STATE_SUBSCRIBE_STOP_MS), ConnectionState())

    /** Talk mode (Idle | Hold | Continuous), owned by the SDK's TalkModeController. Exposed
     *  for the keep-screen-on derivation below (and its reason logging in ChatHost). */
    val talkMode: StateFlow<TalkMode> = component.talkMode
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STATE_SUBSCRIBE_STOP_MS), TalkMode.Idle)

    val micLevels: StateFlow<MicLevelEnvelope> = component.micLevels
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STATE_SUBSCRIBE_STOP_MS), MicLevelEnvelope.silence())

    /**
     * Temporary keep-screen-on condition (S8): `Continuous talk mode OR the assistant is
     * audibly speaking`. Reuses the EXACT [ConnectionState.isSpeaking] signal that drives
     * the existing speaking visuals (BubbleSpeakingWave) — not a new signal. TTS frames
     * buffered during a Hold are NOT "speaking" until they actually play after release,
     * which is the desired semantics here too. Hold itself does not force screen-on: the
     * user's finger on the screen already keeps it awake.
     *
     * Pure combine — no side effects, no logging — so it stays the testable seam. ChatHost
     * (the chat screen) applies the platform FLAG_KEEP_SCREEN_ON and owns every clear path
     * (condition-false, screen teardown), logging the reason for each transition there.
     */
    val keepScreenOn: StateFlow<Boolean> = combine(talkMode, connection) { mode, conn ->
        mode == TalkMode.Continuous || conn.isSpeaking
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STATE_SUBSCRIBE_STOP_MS), false)

    init {
        log.info("init", mapOf("sessionId" to (sessionId ?: "<new>")))
        // A null route entry is a cold/new-chat boundary, not an implicit reattach.
        // Preparation is explicit and fire-and-forget; the gateway buffers the first
        // message while the composer remains usable.
        if (sessionId == null) component.switchConversation.startFreshChat()
        else component.switchConversation(sessionId)
        // COLD-RECONCILE: an existing-conversation switch reloads authoritative history
        // from REST. That cold snapshot carries NO pendingId, so reconcile-by-pendingId
        // can't drop a still-pending optimistic bubble → a duplicate. On the cold-replace
        // signal, drop every still-present optimistic entry (now in the authoritative
        // history, or already swept to FAILED).
        viewModelScope.launch {
            component.observeChat.coldHistoryReplaceSignal().collect {
                component.observeChat.onColdHistoryReplace(cache)
            }
        }
        viewModelScope.launch {
            component.observeChat(cache.pending).collect { model ->
                // Reconcile: drop optimistic entries whose committed echo arrived. Driven by
                // the LIVE echo (model.reconciledPendingIds) from the in-memory timeline —
                // NOT model.committed.pendingId (the committed twin may carry it null).
                model.reconciledPendingIds.forEach(cache::remove)
                // Rebuild from the model, but carry the permission gate across: it is a
                // DECISION the user must answer (spec §7.1), not a slice derived from the
                // chat model. Wholesale replacement here would dismiss an open dialog on
                // the next streamed token or tool-status tick.
                _state.value = ChatUiState(
                    model = model,
                    pendingPermissionRequest = _state.value.pendingPermissionRequest,
                )
            }
        }
        // Drain the outbox on every READY emission AND sweep unacked timeouts. Both
        // operations are idempotent: flushIfReady is a no-op when not READY or nothing
        // queued; sweepTimeouts is a no-op when nothing is sent-but-unechoed.
        viewModelScope.launch {
            component.connection.state.collect { conn ->
                component.sendMessage.flushIfReady(cache, conn.status)
                if (cache.pending.value.isNotEmpty()) cache.sweepTimeouts()
            }
        }
        // Periodic sweep: drives unacked-timeout FAILED transitions even when there are
        // no connection events. Runs only while pending entries exist; cancels on VM clear.
        viewModelScope.launch {
            while (isActive) {
                delay(SWEEP_INTERVAL_MS)
                if (cache.pending.value.isNotEmpty()) {
                    cache.sweepTimeouts()
                }
            }
        }
        // Collect the one-shot ReopenFailed notice from the component. Folds it into
        // UI state as a transient notice; auto-dismissed after 4 s or on tap. The VM
        // owns the lifetime of this collection so the event is never dropped on a
        // lifecycle pause — it is already folded into the durable state snapshot.
        viewModelScope.launch {
            component.reopenFailed.collect {
                log.info("reopen-failed.notice.show")
                _state.value = _state.value.copy(reopenFailedNotice = REOPEN_FAILED_NOTICE)
                delay(REOPEN_FAILED_AUTO_DISMISS_MS)
                // Auto-dismiss only if not already cleared by a tap.
                if (_state.value.reopenFailedNotice != null) {
                    log.debug("reopen-failed.notice.auto-dismiss")
                    _state.value = _state.value.copy(reopenFailedNotice = null)
                }
            }
        }
        startPermissionCollecting()
    }

    /**
     * Dedicated collector for the SDK's open-permission-prompt list (design spec
     * §7.1) — a SEPARATE loop from every other collector in [init], never folded
     * into [ChatComponent.reopenFailed]'s or any other block. The connector already
     * carries the single-outcome-per-requestId invariant (it removes a prompt on
     * the user's response AND on the gateway's `permission.resolved`), so this
     * collector just mirrors the head of that list into [ChatUiState] and arms the
     * defensive local-timeout fallback per prompt. Head-of-list is "the current
     * prompt": SessionRuntime blocks the turn on one at a time, so the list holds
     * more than one only transiently.
     */
    private fun startPermissionCollecting() {
        viewModelScope.launch {
            component.permissions.collect { open ->
                val pending = open.firstOrNull()
                val previous = _state.value.pendingPermissionRequest
                permissionTimeoutJob?.cancel()
                // Log the TRANSITION only — the list re-emits (and replays its empty
                // initial value on every VM build) without the head prompt changing.
                // toolName is a fixed MCP-route identifier, not user content. NEVER log
                // `description` or `args` — those are chat content (PrivacyGuardTest).
                if (previous?.requestId != pending?.requestId) {
                    log.info(
                        "permission.pending.changed",
                        mapOf(
                            "hasPending" to (pending != null),
                            "toolName" to (pending?.toolName ?: "<none>"),
                            "open" to open.size,
                        ),
                    )
                }
                _state.value = _state.value.copy(pendingPermissionRequest = pending)
                if (pending != null) armLocalTimeoutFallback(pending)
            }
        }
    }

    /**
     * Defensive UI-only backstop (design spec §7.1): if neither the user's own tap
     * nor the gateway's `permission.resolved` frame clears this prompt by its
     * `expiresAtMs`, clear it locally so the dialog can never hang forever on a
     * lost/delayed frame. NEVER an approval or a denial — nothing is sent to the
     * server from this path; by the time it fires the gateway's own matching timeout
     * has already fail-closed denied the tool call server-side. Guarded by
     * [shouldClearOnLocalTimeout] against a stale fire clobbering a newer request.
     */
    private fun armLocalTimeoutFallback(request: PermissionPrompt) {
        permissionTimeoutJob = viewModelScope.launch {
            delay((request.expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0))
            if (shouldClearOnLocalTimeout(_state.value.pendingPermissionRequest, request.requestId)) {
                log.warn("permission.local-timeout-fallback", mapOf("requestId" to request.requestId))
                _state.value = _state.value.copy(pendingPermissionRequest = null)
            }
        }
    }

    private val isReady: Boolean get() = connection.value.status == SdkStatus.READY

    fun send(text: String) {
        val id = UUID.randomUUID().toString()
        log.info("send", mapOf("len" to text.length, "pendingId" to id))
        cache.enqueue(id, text)
        if (isReady) component.sendMessage.flushIfReady(cache, connection.value.status)
    }

    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        cache.retry(pendingId)
        // Verify the socket rather than trusting a possibly-stale READY (see iOS note).
        component.ensureConnected()
        component.sendMessage.flushIfReady(cache, connection.value.status)
    }

    // Talk-mode intents (design spec §3) — thin passthroughs to the component. All mode
    // semantics live in the SDK's TalkModeController; the VM never decides anything here.

    /** Corner mic pressed (idle→hold) — press-to-talk begins (fire-and-forget). */
    fun pressMic() {
        log.info("pressMic")
        component.pressMic()
    }

    /** Corner mic released below the lock threshold (hold→idle). */
    fun releaseMic() {
        log.info("releaseMic")
        component.releaseMic()
    }

    /** Corner mic slid to lock (hold→locked) — continuous/hands-free begins. */
    fun lockMic() {
        log.info("lockMic")
        component.lockMic()
    }

    /** Locked control released to stop (locked→idle) — hands-free ends. */
    fun stopContinuous() {
        log.info("stopContinuous")
        component.stopContinuous()
    }

    fun toggleTts() {
        viewModelScope.launch { component.setTtsEnabled(!connection.value.prefs.ttsEnabled) }
    }

    fun interrupt() = component.interrupt()

    fun reconnect() = component.forceReconnect()

    /**
     * Engagement signal from the chat screen: fires on screen entry (LaunchedEffect)
     * and on composer focus. Idempotent — READY → liveness probe; not-READY → reconnect.
     */
    fun ensureConnected() {
        log.debug("ensureConnected")
        component.ensureConnected()
    }

    /**
     * Composer gained keyboard focus — user is about to type; ensure the connection is
     * live so the first send is not blocked by a stale reconnect race.
     */
    fun onComposerFocus() {
        log.debug("onComposerFocus")
        component.ensureConnected()
    }

    /** Acknowledge the ReopenFailed notice (tap-to-dismiss). Idempotent. */
    fun dismissReopenFailedNotice() {
        log.debug("reopen-failed.notice.dismissed")
        _state.value = _state.value.copy(reopenFailedNotice = null)
    }

    /** User tapped Allow on the permission-prompt dialog (design spec §7.1). */
    fun allowPermission() = respondToPermission(approved = true)

    /** User tapped Deny on the permission-prompt dialog (design spec §7.1). */
    fun denyPermission() = respondToPermission(approved = false)

    private fun respondToPermission(approved: Boolean) {
        val requestId = _state.value.pendingPermissionRequest?.requestId ?: return
        permissionTimeoutJob?.cancel()
        log.info("permission.response.sent", mapOf("requestId" to requestId, "approved" to approved))
        // Optimistic local clear, ahead of the round trip — same shape as the
        // OutboundCache's optimistic sends. The connector drops the prompt from its
        // open list too, so the mirrored StateFlow converges on the same value.
        _state.value = _state.value.copy(pendingPermissionRequest = null)
        component.respondToPermission(requestId, approved)
    }

    companion object {
        /** Keep the connection StateFlow warm briefly across config changes. */
        private const val STATE_SUBSCRIBE_STOP_MS = 5_000L
        /** Periodic sweep interval for unacked-timeout detection. */
        private const val SWEEP_INTERVAL_MS = 1_000L
        /** Auto-dismiss the ReopenFailed notice after this duration (ms). */
        private const val REOPEN_FAILED_AUTO_DISMISS_MS = 4_000L
    }
}
