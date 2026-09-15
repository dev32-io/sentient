// ---------------------------------------------------------------------------
// SentientSdk — THE orchestrator. Wires transport + connectors + handshake +
// reconnect into the split observable surfaces:
//   connection: StateFlow<ConnectionState>  — transport + voice axis
//   timeline:   StateFlow<List<ChatMessage>> — committed message history
//   events:     SharedFlow<SdkEvent>         — one-shot notifications
// Mirrors web-sdk sentient-sdk.ts. Split across: StateDeriver, Handshake,
// SdkConnectors, SdkLifecycle. This file owns the public surface + state plumbing.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.DelegationSnapshotItem
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.connectors.SessionsListPage
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import io.sentient.mobilesdk.connectors.SessionsTransportException
import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ResumeParams
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.secure.DeviceIdProvider
import io.sentient.mobilesdk.sessions.SessionsHttpClient
import io.sentient.mobilesdk.transport.ConnectResult
import io.sentient.mobilesdk.transport.MessageRouter
import io.sentient.mobilesdk.transport.NoOpResumeCursorStore
import io.sentient.mobilesdk.transport.ReconnectController
import io.sentient.mobilesdk.transport.ResumeCursor
import io.sentient.mobilesdk.transport.ResumeCursorPersistence
import io.sentient.mobilesdk.transport.ResumeCursorStore
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.WS_NORMAL_CLOSURE
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.voice.io.MicLevelEnvelope
import io.sentient.mobilesdk.voice.io.VoiceAudioState
import io.sentient.mobilesdk.voice.talk.TalkMode
import io.sentient.mobilesdk.voice.talk.TalkModeController
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.concurrent.Volatile
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.cancellation.CancellationException
import kotlin.random.Random

private const val DEFAULT_SESSIONS_TIMEOUT_MS = 5_000L
private const val DEFAULT_CAPTURE_TEARDOWN_TIMEOUT_MS = 1_000L
private const val DEFAULT_TRANSPORT_TEARDOWN_TIMEOUT_MS = 1_000L

/** Durable navigation proof, independent of transport attachment. */
data class AcknowledgedSessionRoute(val sessionId: String, val generation: Long)

private enum class RoutePhase { ATTACHED, FENCED, PREPARING_DRAFT, DRAFT, MINTING, RECOVERING_MINT }

private class SessionActivationRequest(val sessionId: String, val routeGeneration: Long) {
    val result = CompletableDeferred<Unit>()
    var job: Job? = null
    var awaitingAck: Boolean = false
}

/** Restartable root used only by the voice lane. Terminal logout cancels and joins the
 * current root; reconnect creates a fresh root before restarting the lane. */
internal class RestartableSdkScope(
    private val dispatcher: CoroutineDispatcher,
) : CoroutineScope {
    @Volatile private var root: Job = SupervisorJob()
    override val coroutineContext: CoroutineContext get() = root + dispatcher

    val activeChildCount: Int get() = root.children.count { it.isActive }
    val isRootActive: Boolean get() = root.isActive

    suspend fun cancelRootAndJoin() {
        root.cancelAndJoin()
    }

    fun renew() {
        if (!root.isActive) root = SupervisorJob()
    }
}

/** A1: "stuck" only when a turn is active AND the socket is not healthy. A slow healthy
 *  turn stays READY and never arms — no content-frame false-positives. */
internal fun shouldWatchStuck(cognition: CognitionState, isSpeaking: Boolean, status: SdkStatus): Boolean =
    (cognition != CognitionState.IDLE || isSpeaking) && status != SdkStatus.READY

class SentientSdk(
    private val config: SdkConfig,
    private val bundle: PlatformBundle,
    private val scope: CoroutineScope,
    newId: () -> String = { Random.nextLong().toString(16) },
    private val delayFn: suspend (Long) -> Unit = { delay(it) },
    private val sessionsTimeoutMs: Long = DEFAULT_SESSIONS_TIMEOUT_MS,
    private val captureTeardownTimeoutMs: Long = DEFAULT_CAPTURE_TEARDOWN_TIMEOUT_MS,
    private val transportTeardownTimeoutMs: Long = DEFAULT_TRANSPORT_TEARDOWN_TIMEOUT_MS,
    /** REST client for session queries. Null in tests that don't exercise REST. */
    sessionsHttpClient: SessionsHttpClient? = null,
    /**
     * Durable resume-cursor persistence. Dependency-inverted: the SDK defines the
     * interface so a higher layer COULD supply a durable backing. None does today —
     * mobile-data keeps the chat timeline in-memory and injects nothing — so this
     * defaults to a no-op and the in-memory cursor dies with the process (a cold
     * relaunch takes the recovered:false REST-refetch path). When set, it seeds the
     * cursor on resume-prep, persists on advance (coalesced to turn boundaries), and
     * clears on a non-recovered reset / delete.
     */
    private val resumeCursorStore: ResumeCursorStore = NoOpResumeCursorStore,
) {
    private val log = createLogger("sdk", "orchestrator")
    private val disconnectMutex = Mutex()
    @Volatile private var terminallyDisconnected = false

    private val _connection = MutableStateFlow(ConnectionState())
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
    val timeline: StateFlow<List<ChatMessage>> = _timeline.asStateFlow()

    // Open L3 confirm prompts (§7.1). A StateFlow is conflation-SAFE here only because
    // every emitted value carries EVERY still-open prompt — never model this as a single
    // nullable prompt, or two back-to-back requests would lose the first. The arrival
    // one-shots ride [events] (buffered, suspend-on-overflow).
    private val _permissions = MutableStateFlow<List<PermissionPrompt>>(emptyList())
    val permissions: StateFlow<List<PermissionPrompt>> = _permissions.asStateFlow()

    /** Live background-delegation rows (§5.4). Same cumulative-list rationale. */
    private val _delegations = MutableStateFlow<List<DelegationSnapshotItem>>(emptyList())
    val delegations: StateFlow<List<DelegationSnapshotItem>> = _delegations.asStateFlow()

    /**
     * The composer task strip's mirror of `tasklist.state` (FULL STATE every frame —
     * see [io.sentient.mobilesdk.connectors.TaskListConnector]). Split out as its own
     * surface (tile-derivation-strip task): the chat timeline no longer folds tool
     * activity into [ChatMessage] rows, but the composer strip still needs the list to
     * render it. Conflation-safe — the gateway always sends the complete list, never a
     * delta.
     */
    private val _tasks = MutableStateFlow<List<TaskListItem>>(emptyList())
    val tasks: StateFlow<List<TaskListItem>> = _tasks.asStateFlow()

    private val _events = MutableSharedFlow<SdkEvent>(
        replay = 0,
        extraBufferCapacity = EVENTS_BUFFER_CAPACITY,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )
    val events: SharedFlow<SdkEvent> = _events.asSharedFlow()

    private fun emitEvent(event: SdkEvent) {
        if (!_events.tryEmit(event)) {
            scope.launch { _events.emit(event) }
        }
    }

    private val deriver = StateDeriver(bundle.clock)
    private val stuckWatchdog = StuckStateWatchdog(
        timeoutMs = config.stuckStateTimeoutMs,
        scope = scope,
        delayFn = delayFn,
        onTimeout = ::onStuckTimeout,
    )

    // The active ACP session uuid, anchored ONLY from session.switched /
    // session.created broadcasts (non-empty ids). Drives the reconnect re-
    // establish (fire conversation.activate on a reconnect READY to restore server
    // context) and is cleared on consumer disconnect(clearSession = true).
    // NOT a persistent connect-URL resume — see Task A1.
    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    // Send authority for the current transport. Unlike the durable anchor above,
    // this is cleared on every transport edge and route intent, then restored only
    // by an acknowledged switch/create/draft or recovered resume.
    private val _outboundSessionId = MutableStateFlow<String?>(null)
    val outboundSessionId: StateFlow<String?> = _outboundSessionId.asStateFlow()

    // Local route-instance identity. Changes on every user route intent, even when
    // the target session id repeats; reconnect restoration preserves it.
    // Delivery-attempt identity survives conflation of fast drop/reconnect state changes.
    private val _transportGeneration = MutableStateFlow(0L)
    val transportGeneration: StateFlow<Long> = _transportGeneration.asStateFlow()
    private var nextOutboundRouteGeneration = 0L
    private val _outboundRouteGeneration = MutableStateFlow<Long?>(null)
    val outboundRouteGeneration: StateFlow<Long?> = _outboundRouteGeneration.asStateFlow()
    private var desiredSessionId: String? = null
    // Inbound target gate only. Outbound stays independently gated by outboundSessionId.
    private var routePhase = RoutePhase.ATTACHED
    private val routeFenced: Boolean
        get() = routePhase == RoutePhase.FENCED || routePhase == RoutePhase.PREPARING_DRAFT || routePhase == RoutePhase.RECOVERING_MINT
    private var draftRequestId: String? = null
    private val _acknowledgedRoute = MutableStateFlow<AcknowledgedSessionRoute?>(null)
    val acknowledgedRoute: StateFlow<AcknowledgedSessionRoute?> = _acknowledgedRoute.asStateFlow()

    // True once the SDK has reached READY at least once on this orchestrator.
    // Distinguishes a RECONNECT-READY (re-establish the anchored session) from
    // the FIRST connect-READY (nothing to restore). Never reset — survives
    // idle/drop/reconnect, matching hasSession.
    private var hasReachedReadyOnce = false

    // In-flight foreground liveness probe: completed by onPong() when the pong
    // for our ping arrives. Null when no probe is pending. A new probe supersedes
    // (cancels) any prior one.
    private var pendingProbe: CompletableDeferred<Unit>? = null

    // The session id a reconnect re-establish switch is currently awaiting
    // confirmation for. Set when the re-establish switch fires; cleared when its
    // session.switched lands. An unavailable error while this is non-null means
    // the anchored session was revoked → drop the anchor.
    private var reestablishingSessionId: String? = null
    private val reestablishing = MutableStateFlow(false)

    // Explicit activations are serialized because conversation.activate errors carry no
    // requestId. Latest intent fences stale session.attached/switched frames globally.
    private val activationMutex = Mutex()
    private var latestActivation: SessionActivationRequest? = null
    private var inFlightActivation: SessionActivationRequest? = null
    private var activationCorrelationDirty = false
    private val staleActivationIds = mutableSetOf<String>()
    private val activationTimeoutMs = sessionsTimeoutMs * 2

    // FaultHooks declared early so the lifecycle can reference it (network/transport faults).
    private val faultHooks = FaultHooks()

    // Resume cursor (Task 3.10): tracks seq/epoch so replayed frames dedup and the
    // reconnect stream.resume carries the right {epoch,lastSeq}. The SDK owns it;
    // WsTransport peels the header + emits seq, the pump applies the cursor (mirrors
    // the web split). Task 4.7 persists it durably via [cursorPersistence].
    private val resumeCursor = ResumeCursor()

    // Task 4.7 durable persistence: seeds the empty cursor on resume-prep, persists
    // on advance (coalesced to turn boundaries), clears on a non-recovered reset /
    // delete. Keyed by the live currentSessionId so it never holds a stale anchor.
    private val cursorPersistence = ResumeCursorPersistence(
        cursor = resumeCursor,
        store = resumeCursorStore,
        conversationId = { _currentSessionId.value },
    )

    // Stable per-install device id (Task 3.10). Resolved ONCE — the gateway requires
    // it in session.configure and keys the per-device replay buffer by it.
    private val deviceId: String = DeviceIdProvider(bundle.deviceIdStore).getOrCreate()

    // Downlink voice pipeline (E3). Built BEFORE connectors so the downlink hooks
    // exist when the connector set reads them. The real-time mic UPLINK lives in the
    // voice/ package (SdkVoice) — SdkAudio is downlink-only. See SdkAudio.
    private val audio: SdkAudio = SdkAudio(
        audioConfig = config.audio,
        voiceAudio = bundle.voiceAudio,
        scope = scope,
        onStateChanged = ::onAudioStateChanged,
        // Lazy-arm the downlink engine on the first TTS turn (mirrors web-sdk's
        // arm-on-audio.start model). Deferred accessors — `voice` is constructed AFTER
        // `audio`, but these only fire at audio.start / drain, long after construction.
        armPlayback = { voice.armPlayback() },
        disarmPlayback = { voice.requestPlayback(false) },
    )

    // The voice lane has an SDK-owned non-main lifecycle. Platform session owners may cancel
    // their orchestration scope immediately after initiating logout; this scope survives just
    // long enough for the bounded ordered cancel attempt, then [disconnect] shuts its lane.
    private val voiceLifecycleScope = RestartableSdkScope(Dispatchers.Default)

    internal val activeVoiceLifecycleChildren: Int get() = voiceLifecycleScope.activeChildCount
    internal val isVoiceLifecycleRootActive: Boolean get() = voiceLifecycleScope.isRootActive
    internal val hasActiveCapture: Boolean get() = connectors.audioInput.hasActiveCapture

    // Real-time voice-uplink pipeline (Task 9). Built like SdkAudio — BEFORE the
    // connector set, reaching connectors.audioInput via a lazy lambda. Null voiceAudio
    // (text/test path) → no pipeline; startMic/stopMic still send audio.start/end.
    private val voice: SdkVoice = SdkVoice(
        voiceAudio = bundle.voiceAudio,
        audioConfig = config.audio,
        audioInput = { connectors.audioInput },
        // Control-frame senders ride the SAME serialized lane as pipeline start/stop
        // (audio.start before frames, audio.end after). Lazily deref'd — connectors
        // is only deref'd when the consumer invokes these, exactly like audioInput.
        onUplinkStart = { capture, turnMode -> canSendUserInput() && connectors.audioInput.startStreaming(capture, turnMode) },
        onUplinkBeginTerminal = { capture -> connectors.audioInput.beginTerminal(capture) },
        onUplinkTerminal = { capture, terminal -> connectors.audioInput.completeTerminal(capture, terminal) },
        onUplinkForceLocalTerminal = { generation -> connectors.audioInput.forceLocalTerminalCleanup(generation) },
        scope = voiceLifecycleScope,
    )

    /** Reactive engine readiness (Idle → Configuring → Ready / Error). UI spinner off
     *  this. Idle unless a real VoiceAudio is wired (text/test path). Engine readiness
     *  surface exposed by [SdkVoice.audioState] — the single source of truth
     *  for the UI spinner + the SDK reconfig decision. */
    val audioState: StateFlow<VoiceAudioState> = voice.audioState

    /** Read-only aggregate microphone envelope for native waveform consumers. */
    val micLevels: StateFlow<MicLevelEnvelope> = voice.micLevels

    // Talk-mode brain (design spec §3), constructed at the SDK composition site over its
    // 6 documented seams — all existing surfaces (S3 recipe B). Capture start/stop ride
    // SdkVoice's serialized command lane (carrying TurnMode on the mic-rising edge); the
    // press-interrupt reuses the SDK's own interrupt(); the hold defer drives the downlink
    // pipeline's buffer-and-defer. Wiring only — the FSM + effect ordering (interrupt-on-press,
    // beginHold-before-capture, back-to-back end+start on lock) live entirely in the controller.
    private val talkModeController = TalkModeController(
        startCapture = { turnMode -> voice.requestStart(turnMode) },
        endCapture = { voice.requestStop() },
        cancelCapture = { voice.requestCancel() },
        interrupt = { interrupt() },
        isCycleOrTtsActive = { deriver.cognition != CognitionState.IDLE || deriver.isSpeaking },
        beginHoldDefer = { audio.pipeline.beginHold() },
        endHoldDefer = { audio.pipeline.endHold() },
        discardHoldDefer = { audio.pipeline.discardHold() },
    )

    /** Talk mode (Idle | Hold | Continuous), owned by [talkModeController]. Hot StateFlow per
     *  the split observable-surface rule (conflation fine — latest wins); NOT folded into a
     *  delta stream. The corner-mic affordance / future UI renders off this. */
    val talkMode: StateFlow<TalkMode> = talkModeController.mode

    // VoiceAudio is the shared capture authority. A transient mic=false projection during
    // interrupt/reconfigure is intentionally ignored; only a typed Error or terminal Idle
    // teardown can revoke an optimistic Hold/Continuous mode. The controller reset is
    // idempotent and emits no duplicate stop/release intent.
    init {
        scope.launch {
            var previousPhase: VoiceAudioState.Phase? = null
            voice.audioState.collect { state ->
                // Do not interpret the initial Idle snapshot as a teardown. Idle is
                // authoritative only after the engine has previously been active.
                val genuineLoss = state.phase == VoiceAudioState.Phase.Error ||
                    (state.phase == VoiceAudioState.Phase.Idle && previousPhase != null && previousPhase != VoiceAudioState.Phase.Idle)
                previousPhase = state.phase
                if (genuineLoss) {
                    talkModeController.lifecycleCancel(
                        if (state.phase == VoiceAudioState.Phase.Error) "audio-error" else "audio-teardown",
                    )
                    syncVoiceMode()
                }
            }
        }
    }

    private val connectors = SdkConnectors(
        deriver = deriver,
        emit = ::emit,
        emitEvent = ::emitEvent,
        send = ::sendControl,
        sendAwaited = ::sendControlAwaited,
        sendBinary = ::sendBinary,
        newId = newId,
        sessionsTimeoutMs = sessionsTimeoutMs,
        clock = bundle.clock,
        mintDebounceMs = config.mintDebounceMs,
        sessionsHttpClient = sessionsHttpClient,
        scope = scope,
        audioHooks = { audio.downlinkHooks },
        onCognitionChanged = ::onCognitionChanged,
        onPermissionsChanged = { prompts -> _permissions.value = prompts },
        onDelegationsChanged = { list -> _delegations.value = list },
        onTasksChanged = { list -> _tasks.value = list },
        // Lazy-arm model: the downlink engine is armed on connector.audio.start, not from
        // the preference flag. The gateway only sends audio.* when TTS is on, so arming
        // follows the actual audio — no preference→configure coupling needed. The prefs
        // change still folds into the deriver (UI toggle state) inside PreferencesConnector.
    )

    private val router = MessageRouter(connectors.all, audioConnector = connectors.audioOutput)

    private fun onAudioStateChanged(isSpeaking: Boolean, fsmState: AudioState) {
        deriver.isSpeaking = isSpeaking
        deriver.audioState = fsmState
        refreshStuckWatch()
        emit()
    }

    private fun onCognitionChanged(state: CognitionState) {
        deriver.cognition = state
        refreshStuckWatch()
        emit()
    }

    /**
     * Drop TURN-scoped active state back to idle. Runs on every conversation change,
     * but ALSO on interrupt and on the stuck-state watchdog — i.e. while the client
     * stays in the same conversation. Nothing conversation-scoped belongs here; that
     * is [clearConversationScopedState].
     */
    private fun clearActiveToIdle() {
        connectors.cognition.reset()  // currentState→IDLE + onCognitionChanged → deriver IDLE + refreshStuckWatch + emit
        connectors.permission.reset() // fail-closed: drop open prompts, never auto-approve
        audio.stopLocal()             // isSpeaking→false (if speaking) via onAudioStateChanged
        stuckWatchdog.disarm()
        emit()
    }

    /**
     * Drop CONVERSATION-scoped state when leaving the current conversation. Single
     * writer for every "leave" entry point — [switchSession], [newChat], [sendNewChat]
     * and [sendSwitchSession] — so a new entry point cannot silently skip one clear.
     *
     * Delegation rows (§5.4) outlive the turn that dispatched them and are keyed by
     * taskId alone, and terminal rows are retained by design, so nothing else ever
     * retires them: without this, conversation A's background-task rows render inside
     * conversation B and may never self-clear.
     *
     * The composer task strip's [tasks] mirror has the SAME leak for a different
     * reason: the gateway's `tasklist.state` is a per-session projector that only
     * re-emits on its own mutations, never on `conversation.activate`, so a switch
     * into a conversation with no task activity of its own would otherwise leave
     * [tasks] holding the previous conversation's last-known rows forever.
     *
     * Deliberately NOT folded into [clearActiveToIdle] (that also runs on interrupt /
     * stuck-watchdog, where the conversation is unchanged and its in-flight
     * delegations/tasks must keep rendering) and NOT into [fireSwitch] (the reconnect
     * re-establish path re-activates the SAME conversation and must preserve them).
     */
    private fun clearConversationScopedState(trigger: String) {
        log.info("conversation.scope.clear", mapOf("trigger" to trigger))
        talkModeController.lifecycleCancel("session-replacement")
        audio.pipeline.suspendPlayback()
        syncVoiceMode()
        connectors.delegation.clear()
        connectors.tasks.clear()
    }

    private fun onStuckTimeout() {
        log.warn("stuck-state.reset", mapOf("status" to deriver.status, "cognition" to deriver.cognition, "isSpeaking" to deriver.isSpeaking))
        clearActiveToIdle()
    }

    private fun refreshStuckWatch() {
        if (shouldWatchStuck(deriver.cognition, deriver.isSpeaking, deriver.status)) stuckWatchdog.arm()
        else stuckWatchdog.disarm()
    }

    private val reconnectController = ReconnectController(
        config = config.reconnect,
        delayFn = delayFn,
        jitterFn = { Random.nextDouble() },
        connect = { lifecycle.attemptConnect() },
        onAuthExpired = { setError(authExpired = true) },
        onConnectionLost = { onReconnectExhausted() },
    )

    private var consumerDisconnected = false

    private val lifecycle = SdkLifecycle(
        scope = scope,
        bundleEngine = bundle.engine,
        allowSelfSignedDevHost = config.allowSelfSignedDevHost,
        gatewayWsUrl = config.gatewayWsUrl,
        deviceId = deviceId,
        router = router,
        delayFn = delayFn,
        hooks = Hooks(),
        applyCursor = ::applyCursor,
        log = createLogger("sdk", "lifecycle"),
        handshakeLog = createLogger("sdk", "handshake"),
        onProtocolError = { err -> emitEvent(SdkEvent.ProtocolError(err)) },
        faultHooks = if (config.devFaultsEnabled) faultHooks else null,
    )

    // ── Public surface ───────────────────────────────────────────────────────

    /** Debug-only fault hooks; null unless config.devFaultsEnabled. Consulted at boundaries in Phase 5. */
    fun devFaults(): FaultHooks? = if (config.devFaultsEnabled) faultHooks else null

    /**
     * Flip [ConnectionState.authExpired] = true via the existing terminal-auth path
     * ([setError]) — the SAME path [Hooks.onAuthFailed] uses, so there is one source
     * of auth-state truth. Public, NON-suspend, and NEVER throws (no `@Throws`) so a
     * platform connection-scope CoroutineExceptionHandler can route a classified auth
     * failure to login without crossing a suspend/throwing boundary. SKIE exposes it
     * to Swift as a plain method.
     */
    fun signalAuthExpired() {
        log.warn("signalAuthExpired")
        setError(authExpired = true)
    }

    /**
     * Open the WS, authenticate, configure, reach READY. Suspends until settled.
     *
     * Re-entrancy guard (web-sdk parity, sentient-sdk.ts connect()): a no-op
     * unless the SDK is DISCONNECTED or RECONNECTING — connect() never tears down
     * a live (CONNECTING/AUTHENTICATING/READY) session. Re-arms the reconnect
     * controller (clears the cancel() latch set by a prior disconnect()) so the
     * process-singleton SdkHolder is reusable across logout→login.
     */
    suspend fun connect() {
        val current = deriver.status
        if (current != SdkStatus.DISCONNECTED && current != SdkStatus.RECONNECTING) {
            log.info("connect.noop", mapOf("status" to current))
            return
        }
        consumerDisconnected = false
        if (terminallyDisconnected) {
            voiceLifecycleScope.renew()
            terminallyDisconnected = false
        }
        voice.resumeAfterTeardown()
        reconnectController.reset()
        when (val result = lifecycle.attemptConnect()) {
            is ConnectResult.Success -> log.info("connect.ready")
            is ConnectResult.Failure -> log.warn("connect.failed", mapOf("kind" to result.kind))
        }
    }

    /**
     * Tear down the WS + all loops. Idempotent. Status → DISCONNECTED.
     *
     * @param clearSession true (default — logout/consumer teardown) clears
     *   the hasSession slice so the gate falls back to login. false (transient
     *   teardown) keeps the user "in session" (gate stays on chat; SDK
     *   auto-reconnects on the next presence signal).
     */
    suspend fun disconnect(clearSession: Boolean = true) = disconnectMutex.withLock {
        if (clearSession && terminallyDisconnected) return@withLock
        log.info("disconnect", mapOf("clearSession" to clearSession))
        consumerDisconnected = true
        _outboundSessionId.value = null
        voice.beginTeardown()
        // Teardown is a genuine capture loss. Reset shared TalkMode, then fence the voice
        // lane before transport/audio disposal. This guarantees producer stop/join and the
        // matching Cancel control complete while both the socket and voice root still exist.
        talkModeController.lifecycleCancel("disconnect")
        syncVoiceMode()
        val orderedCaptureTeardown = voice.cancelCaptureAndAwait(captureTeardownTimeoutMs)
        if (!orderedCaptureTeardown) {
            log.warn("capture.teardown-timeout", mapOf("timeoutMs" to captureTeardownTimeoutMs))
        }
        reconnectController.cancel()
        cancelSessionActivations()
        connectors.sessions.reset()
        // Terminal teardown (logout) frees the native codecs; a transient disconnect
        // (reconnect) keeps them so TTS survives the next reconnect.
        if (clearSession) audio.dispose() else audio.suspendForReconnect()

        if (clearSession) {
            // Detach first so no SDK loop can retain or reuse this session. Its close runs as
            // a child of the caller's teardown coroutine—not in an SDK scope that outlives
            // logout—and a timeout explicitly cancels and joins that child.
            closeTransportBounded(lifecycle.detach())
        } else {
            lifecycle.teardown()
        }
        staleActivationIds.clear()
        clearTransportSessionState()
        if (clearSession && deriver.hasSession) {
            log.info("hasSession.clear", mapOf("trigger" to "logout"))
            deriver.hasSession = false
        }
        if (clearSession) {
            log.info("session.anchor.clear", mapOf("trigger" to "logout"))
            _currentSessionId.value = null
            _outboundRouteGeneration.value = null
            desiredSessionId = null
            _acknowledgedRoute.value = null
            draftRequestId = null
            routePhase = RoutePhase.FENCED
        }
        setStatus(SdkStatus.DISCONNECTED)
        stuckWatchdog.disarm()
        if (clearSession) {
            terminallyDisconnected = true
            voice.shutdownLane()
            // Ordering is deliberate: capture terminalization, transport close attempt, then
            // root cancellation/join. No SDK-owned teardown child survives this return.
            voiceLifecycleScope.cancelRootAndJoin()
        }
    }

    private suspend fun closeTransportBounded(open: WebSocketSession?) {
        if (open == null) return
        supervisorScope {
            val closeChild = launch {
                try {
                    open.close(WS_NORMAL_CLOSURE, "User disconnect")
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    log.warn("transport.close-failed", mapOf("code" to "transport-close-failed"))
                }
            }
            val completed = withTimeoutOrNull(transportTeardownTimeoutMs) {
                closeChild.join()
                true
            } ?: false
            if (!completed) {
                closeChild.cancelAndJoin()
                log.warn("transport.close-timeout", mapOf("timeoutMs" to transportTeardownTimeoutMs))
            }
        }
    }

    /** Send user text (text.input). Mirrors web-sdk sendText. */
    fun sendText(text: String, pendingId: String? = null) {
        if (!canSendUserInput()) return
        markInteraction()
        connectors.text.sendText(text, pendingId)
    }

    /** UI Stop / Escape — idempotent hard interrupt. Fire-and-forget: clears local
     *  UI state immediately, never waits for a server ack (a dead socket sends none). */
    fun interrupt() {
        log.info("interrupt")
        markInteraction()
        connectors.turnError.noteInterrupt(null)
        clearActiveToIdle()
        sendControl(ClientMessage.Interrupt) // best-effort; null-safe if transport is dead
    }

    /**
     * Answer an open permission prompt (design §7.1). Fail-closed by construction: NOT
     * calling this is never an approval — the gateway auto-denies at its 2-minute timeout
     * and echoes permission.resolved{outcome:"timeout"}.
     */
    fun respondToPermission(requestId: String, approved: Boolean) {
        log.info("permission.respond", mapOf("requestId" to requestId, "approved" to approved))
        markInteraction()
        connectors.permission.respond(requestId, approved)
    }

    /** Start the voice uplink: flip voiceMode ACTIVE, then request the serialized
     *  configure(mic=true, playback=<current tts>) on [SdkVoice]'s single lane. The lane
     *  emits audio.start, runs VoiceAudio.configure (mic tap up), and starts the uplink
     *  collect — in that order, serialized with stopMic and setTtsEnabled. */
    fun startMic() {
        if (!canSendUserInput()) return
        log.info("startMic", mapOf("voiceAudioWired" to (bundle.voiceAudio != null)))
        markInteraction()
        deriver.voiceMode = VoiceMode.ACTIVE
        voice.requestStart()
        emit()
    }

    /** Stop the voice uplink: flip voiceMode OFF, request configure(mic=false, ...).
     *  The lane stops the uplink collect, runs VoiceAudio.configure (mic tap down), and
     *  emits audio.end LAST — so no late frame can race past audio.end. */
    fun stopMic() {
        log.info("stopMic")
        deriver.voiceMode = VoiceMode.OFF
        voice.requestStop()
        emit()
    }

    // ── Talk-mode intents (design spec §3) — the stable UI contract ──────────────
    // The corner-mic gesture layer (both apps) emits ONLY these four intents; ALL mode
    // semantics (interrupt-on-press, turnMode on capture, buffer-and-defer, back-to-back
    // end+start on lock) live in [talkModeController]. Each intent delegates to the controller,
    // then projects the resulting TalkMode onto the voice-axis [VoiceMode] mirror via
    // [syncVoiceMode] so the existing listening-glow + external-sync surface stays in lockstep.

    /** Idle → Hold. Press-to-talk begins (press IS the barge-in). */
    fun pressMic() {
        if (!canSendUserInput()) return
        log.info("pressMic")
        markInteraction()
        talkModeController.pressMic()
        syncVoiceMode()
    }

    /** Hold → Idle. Release finalizes the manual turn; any deferred TTS flushes. */
    fun releaseMic() {
        log.info("releaseMic")
        markInteraction()
        talkModeController.releaseMic()
        syncVoiceMode()
    }

    /** Hold → Continuous. Slide-to-lock: the manual segment finalizes, a semantic turn opens. */
    fun lockMic() {
        if (!canSendUserInput()) return
        log.info("lockMic")
        markInteraction()
        talkModeController.lockMic()
        syncVoiceMode()
    }

    /** Continuous → Idle. Tap-to-stop hands-free. */
    fun stopContinuous() {
        log.info("stopContinuous")
        markInteraction()
        talkModeController.stopContinuous()
        syncVoiceMode()
    }

    fun holdStart() = pressMic()
    fun sendHeld() = releaseMic()
    fun cancelHeld() { talkModeController.cancelHeld(); syncVoiceMode() }
    fun enterAuto() = lockMic()
    fun exitAuto() = stopContinuous()
    fun lifecycleCancel(reason: String = "system") { talkModeController.lifecycleCancel(reason); syncVoiceMode() }

    /** Project the controller's TalkMode onto the voice-axis mirror: the mic is on
     *  (voiceMode ACTIVE) in Hold OR Continuous, off in Idle. Computed from the FINAL mode
     *  after the intent settles, so a lock (Hold→Continuous) never flickers voiceMode OFF.
     *  voiceMode is a pure UI mirror (no SDK logic branches on it). */
    private fun syncVoiceMode() {
        deriver.voiceMode = if (talkMode.value != TalkMode.Idle) VoiceMode.ACTIVE else VoiceMode.OFF
        emit()
    }

    /** Patch TTS on/off; the server echoes via session.preferences.changed and starts /
     *  stops sending turn.audio.* accordingly. The downlink engine is LAZY-ARMED on
     *  audio.start (mirrors web-sdk), so no local configure is needed here — arming
     *  follows the actual audio, not the preference flag. */
    suspend fun setTtsEnabled(enabled: Boolean) {
        log.info("setTtsEnabled", mapOf("enabled" to enabled))
        connectors.preferences.patch(AudioPreferencesPatch(ttsEnabled = enabled))
    }

    /** Patch audio output preferences (TTS on/off and/or reply channel) live over the WS. Null
     *  fields are left unchanged. The server echoes via session.preferences.changed. Used by the
     *  settings Audio fast-save to reflect a saved audio-pref change on the running session with no
     *  restart (superset of [setTtsEnabled], which stays for the chat TTS toggle). */
    suspend fun patchAudioPreferences(patch: AudioPreferencesPatch) {
        log.info("patchAudioPreferences", mapOf("ttsEnabled" to patch.ttsEnabled, "channel" to patch.channel))
        connectors.preferences.patch(patch)
    }

    /**
     * Adopt the user's stored audio preferences WITHOUT sending anything.
     *
     * The connector otherwise starts at [AudioPreferences.DEFAULT] (TTS on) and
     * has no way to learn the truth: the gateway sends no preferences frame at
     * `session.configure`, and `session.preferences.changed` — which both SDKs
     * listen for — is not in `gatewayMessageSchema` at all, so nothing can emit
     * it. A client that never seeds therefore renders the DEFAULT forever,
     * which is how the chat TTS icon showed ON for a user whose stored
     * preference was off.
     *
     * Call once per connection scope with `GET /profile/me`'s `audio` block —
     * the same source webui seeds from (webui app.tsx). Idempotent.
     */
    fun seedAudioPreferences(prefs: AudioPreferences) {
        log.info("seedAudioPreferences", mapOf("ttsEnabled" to prefs.ttsEnabled, "channel" to prefs.channel))
        connectors.preferences.seed(prefs)
    }

    /** Page the session list via REST GET /api/v1/sessions. */
    @Throws(kotlin.coroutines.cancellation.CancellationException::class)
    suspend fun listSessions(limit: Int, offset: Int): SessionsListPage =
        connectors.sessions.list(limit, offset)

    /**
     * Activate a session only after READY and return only after matching
     * session.switched. Concurrent calls use latest-intent-wins semantics.
     */
    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        SessionsTransportException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun switchSession(sessionId: String) {
        val request = SessionActivationRequest(sessionId, claimOutboundRoute())
        beginSessionActivation(request)
        try {
            request.result.await()
        } catch (cancelled: CancellationException) {
            cancelSessionActivation(request)
            throw cancelled
        }
    }

    private fun beginSessionActivation(request: SessionActivationRequest) {
        if (consumerDisconnected || terminallyDisconnected) {
            request.result.completeExceptionally(CancellationException("session activation cancelled by disconnect"))
            return
        }
        if (_currentSessionId.value != request.sessionId) resumeCursor.reset()
        val ambiguousMint = routePhase == RoutePhase.MINTING || routePhase == RoutePhase.RECOVERING_MINT
        desiredSessionId = request.sessionId
        if (_outboundSessionId.value != request.sessionId) {
            _outboundSessionId.value = null
            routePhase = RoutePhase.FENCED
            lifecycle.activeTransport?.commandBinding = null
            voice.invalidateCaptureForRoute()
        }
        if (ambiguousMint) resetAmbiguousActivationTransport()
        val previous = latestActivation
        if (previous != null && previous !== request) {
            previous.result.completeExceptionally(SessionsRequestException("superseded", ""))
            if (inFlightActivation === previous) staleActivationIds += previous.sessionId
            else previous.job?.cancel()
        }
        staleActivationIds -= request.sessionId
        latestActivation = request
        request.job = scope.launch { runSessionActivation(request) }
    }

    private suspend fun runSessionActivation(request: SessionActivationRequest) {
        try {
            withTimeout(activationTimeoutMs) {
                activationMutex.withLock {
                    while (true) {
                        requireLatestActivation(request)
                        if (
                            connection.value.status == SdkStatus.READY &&
                            _outboundSessionId.value == request.sessionId
                        ) return@withLock

                        val ready = connection.first {
                            it.status == SdkStatus.READY || it.status == SdkStatus.ERROR
                        }
                        if (ready.status != SdkStatus.READY) throw SessionsTransportException()
                        requireLatestActivation(request)
                        if (connection.value.status != SdkStatus.READY) continue
                        if (_outboundSessionId.value == request.sessionId) return@withLock

                        if (activationCorrelationDirty) {
                            resetAmbiguousActivationTransport()
                            continue
                        }

                        markInteraction()
                        connectors.turnError.reset()
                        connectors.history.clearForSwitch()
                        clearConversationScopedState("switch")
                        clearActiveToIdle()
                        inFlightActivation = request
                        request.awaitingAck = true
                        var acknowledged = false
                        try {
                            connectors.sessions.switchTo(request.sessionId)
                            acknowledged = true
                            request.awaitingAck = false
                            requireLatestActivation(request)
                            return@withLock
                        } catch (failure: SessionsRequestException) {
                            request.awaitingAck = false
                            throw failure
                        } catch (failure: SessionsTimeoutException) {
                            if (failure.frameType == "connector reset" && latestActivation === request) {
                                request.awaitingAck = false
                                continue
                            }
                            resetAmbiguousActivationTransport()
                            request.awaitingAck = false
                            throw failure
                        } catch (failure: SessionsTransportException) {
                            resetAmbiguousActivationTransport()
                            request.awaitingAck = false
                            throw failure
                        } finally {
                            if (!acknowledged) staleActivationIds += request.sessionId
                            if (inFlightActivation === request) inFlightActivation = null
                        }
                    }
                }
            }
            acknowledgeRoute(request.sessionId)
            request.result.complete(Unit)
        } catch (_: TimeoutCancellationException) {
            if (request.awaitingAck) resetAmbiguousActivationTransport()
            request.awaitingAck = false
            request.result.completeExceptionally(SessionsTimeoutException("session activation"))
        } catch (cancelled: CancellationException) {
            request.result.completeExceptionally(cancelled)
        } catch (failure: Throwable) {
            request.result.completeExceptionally(failure)
        } finally {
            if (latestActivation === request) latestActivation = null
        }
    }

    private fun requireLatestActivation(request: SessionActivationRequest) {
        if (latestActivation !== request) throw SessionsRequestException("superseded", "")
    }

    private fun cancelSessionActivation(request: SessionActivationRequest) {
        if (latestActivation !== request) return
        latestActivation = null
        request.result.cancel()
        if (inFlightActivation === request) staleActivationIds += request.sessionId
        else request.job?.cancel()
    }

    private fun cancelSessionActivations() {
        val request = latestActivation
        latestActivation = null
        if (request != null) {
            request.result.cancel()
            if (inFlightActivation === request) staleActivationIds += request.sessionId
            else request.job?.cancel()
        }
    }

    /** Start a fresh chat; awaits the session.created broadcast. */
    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun newChat(): String {
        ownFreshRoute()
        markInteraction()
        connectors.turnError.reset()
        clearConversationScopedState("new-chat")
        // Bug #1: the gateway clears its own mirror on session.new but emits no
        // client-facing clear; drop the visible past-chat history locally the
        // instant "+" is tapped (safe pure-state clear — never gates the mint).
        connectors.history.clearForNewChat()
        dropAnchorForNewChat()
        val id = connectors.sessions.newChat()
        clearActiveToIdle()
        return id
    }

    /**
     * Identity axis: leave the current conversation ATOMICALLY when a new chat is
     * requested. Until the mint's session.created arrives the anchor is null, so a
     * session.configure fired during the pending mint (relaunch / reconnect) declares
     * NO conversationId — the gateway cannot re-anchor the session to the old
     * conversation (resume.reanchor source="configure"). Without this the stale anchor
     * leaks into configure: the next user.message lands in the previous conversation and
     * the fresh mint is abandoned (a phantom empty session).
     */
    private fun dropAnchorForNewChat() {
        if (_currentSessionId.value != null) {
            log.info("session.anchor.clear", mapOf("trigger" to "new-chat"))
        }
        _currentSessionId.value = null
    }

    /**
     * Eagerly establish an explicit fresh-chat boundary. The old conversation is
     * cleared synchronously; the gateway preparation and first-message mint remain
     * asynchronous so typing is never blocked.
     */
    fun startFreshChat() {
        beginFreshChatRoute()
    }

    /** Start a fresh route and return the local generation its VM cache must bind. */
    fun beginFreshChatRoute(): Long {
        if (consumerDisconnected || terminallyDisconnected) return nextOutboundRouteGeneration
        val generation = ownFreshRoute()
        markInteraction()
        connectors.turnError.reset()
        clearConversationScopedState("new-chat-fire")
        // Bug #1: the gateway clears its own mirror on session.new but emits no
        // client-facing clear; drop the visible past-chat history locally the
        // instant "+" is tapped (safe pure-state clear — never gates the mint).
        connectors.history.clearForNewChat()
        dropAnchorForNewChat()
        connectors.sessions.startFreshChat()
        clearActiveToIdle()
        return generation
    }

    private fun ownFreshRoute(): Long {
        if (consumerDisconnected || terminallyDisconnected) throw CancellationException("fresh route cancelled by disconnect")
        val generation = claimOutboundRoute()
        val inFlight = inFlightActivation
        cancelSessionActivations()
        if (inFlight != null) {
            activationCorrelationDirty = true
            inFlight.job?.cancel()
        }
        desiredSessionId = null
        _outboundSessionId.value = null
        val ambiguous = routePhase == RoutePhase.MINTING || routePhase == RoutePhase.RECOVERING_MINT || activationCorrelationDirty
        routePhase = RoutePhase.PREPARING_DRAFT
        draftRequestId = null
        lifecycle.activeTransport?.commandBinding = null
        voice.invalidateCaptureForRoute()
        if (ambiguous) resetAmbiguousActivationTransport()
        resumeCursor.reset()
        return generation
    }

    private fun claimOutboundRoute(): Long {
        nextOutboundRouteGeneration += 1
        _outboundRouteGeneration.value = nextOutboundRouteGeneration
        return nextOutboundRouteGeneration
    }

    /** Compatibility alias for older platform callers. */
    fun sendNewChat() = startFreshChat()

    /** Compatibility facade for synchronous platform routes. */
    fun sendSwitchSession(id: String) {
        beginSessionRoute(id)
    }

    /** Start a session route and return the local generation its VM cache must bind. */
    fun beginSessionRoute(id: String): Long {
        if (consumerDisconnected || terminallyDisconnected) return nextOutboundRouteGeneration
        val request = SessionActivationRequest(id, claimOutboundRoute())
        if (
            connection.value.status == SdkStatus.READY &&
            _outboundSessionId.value == id
        ) {
            acknowledgeRoute(id)
            return request.routeGeneration
        }
        connectors.history.clearForSwitch()
        clearConversationScopedState("switch-fire")
        clearActiveToIdle()
        beginSessionActivation(request)
        scope.launch {
            try {
                request.result.await()
            } catch (_: CancellationException) {
            } catch (failure: Throwable) {
                log.warn("switch.fire-and-forget-failed", mapOf("code" to failure::class.simpleName))
            }
        }
        return request.routeGeneration
    }

    /** Raw fire-and-forget conversation.activate used only for reconnect re-establishment. */
    private fun fireSwitch(id: String) {
        markInteraction()
        connectors.turnError.reset()
        connectors.sessions.sendSwitch(id)
    }

    /** Delete a session via REST DELETE /api/v1/sessions/:id. Never throws — safeBoolean absorbs all errors. */
    @Throws(kotlin.coroutines.cancellation.CancellationException::class)
    suspend fun deleteSession(id: String) {
        // Drop any durable resume cursor for the deleted conversation (Task 4.7 clear)
        // so a relaunch never seeds a resume for a session the server no longer has.
        cursorPersistence.clearFor(id)
        connectors.sessions.delete(id)
    }

    /** Rename a session via REST PATCH /api/v1/sessions/:id. Never throws — safeBoolean absorbs all errors. */
    @Throws(kotlin.coroutines.cancellation.CancellationException::class)
    suspend fun renameSession(id: String, title: String) = connectors.sessions.rename(id, title)

    /** Search sessions via REST GET /api/v1/sessions/search. */
    @Throws(kotlin.coroutines.cancellation.CancellationException::class)
    suspend fun searchSessions(q: String, limit: Int = 20): List<io.sentient.mobilesdk.protocol.SessionRow> =
        connectors.sessions.search(q, limit)

    // ── Reconnect wiring ────────────────────────────────────────────────────────

    /**
     * Manual reconnect surface (web-sdk parity, sentient-sdk.ts forceReconnect()).
     * Presence/foreground-driven retry the device contract relies on: re-arm the
     * reconnect controller, clear the terminal connectionLost/authExpired flags,
     * and drive a fresh recovery loop. Idempotent — a no-op while a loop is
     * already in flight (status RECONNECTING).
     */
    fun forceReconnect() {
        log.info("forceReconnect", mapOf("status" to deriver.status))
        if (deriver.status == SdkStatus.RECONNECTING) return
        consumerDisconnected = false
        reconnectController.reset()
        deriver.authExpired = false
        onConnectionDrop()
    }

    /**
     * Engagement-driven connectivity check — call from every "user is at the chat"
     * signal (foreground, chat screen appears, composer focus, pre-send). READY =>
     * one liveness probe (delegates to [onForeground]); DISCONNECTED => start a fresh
     * connect via [forceReconnect]; CONNECTING / AUTHENTICATING / RECONNECTING => a
     * connect is already in flight — NO-OP (let the handshake finish). Opening a
     * second socket while a handshake is in flight orphans it and causes the gateway
     * to emit 4002 session-ready timeout → reconnect storm. On-demand only: never a
     * timer, never while backgrounded.
     */
    fun ensureConnected() {
        log.info("ensureConnected", mapOf("status" to deriver.status))
        markInteraction()
        when (deriver.status) {
            SdkStatus.READY -> onForeground()
            SdkStatus.DISCONNECTED -> forceReconnect()
            // CONNECTING / AUTHENTICATING / RECONNECTING / ERROR: a connect is already
            // in flight or terminal — no-op. Starting another would orphan the in-flight
            // handshake (double-connect race). The handshake's ready-timeout self-recovers
            // a genuinely stuck connect. ERROR requires an explicit forceReconnect() call.
            else -> log.info("ensureConnected.skip", mapOf("status" to deriver.status, "reason" to "connect-in-flight-or-terminal"))
        }
    }

    /**
     * Foreground presence signal — the app returned to the foreground.
     *
     * We do NOT proactively drop the socket on background (the gateway keeps the
     * per-user session + ACP wire alive and has no server ping/timeout, so a brief
     * backgrounding survives with the SAME socket — no reload, no reconnect). On
     * foreground we send ONE liveness ping: if a pong returns within the configured
     * window the live socket is confirmed and we do nothing; if it times out (the
     * OS froze/killed the socket while suspended, or it is half-open) we reconnect,
     * which re-establishes the anchored session via conversation.activate. One-shot per
     * foreground — no periodic heartbeat — so the battery cost is one ping.
     */
    fun onForeground() {
        val st = deriver.status
        if (st != SdkStatus.READY) {
            log.info("foreground.not-ready → reconnect", mapOf("status" to st))
            forceReconnect()
            return
        }
        val probe = CompletableDeferred<Unit>()
        pendingProbe = probe // supersede any prior probe — its coroutine no-ops on the identity check below
        sendControl(ClientMessage.Ping)
        scope.launch {
            val ponged = withTimeoutOrNull(config.foregroundProbeTimeoutMs) { probe.await() } != null
            // A newer foreground replaced this probe while it was in flight → do nothing.
            if (probe !== pendingProbe) return@launch
            pendingProbe = null
            if (ponged) {
                log.info("foreground.probe-pong (socket alive)")
            } else {
                log.warn("foreground.probe-timeout → reconnect", mapOf("timeoutMs" to config.foregroundProbeTimeoutMs))
                forceReconnect()
            }
        }
    }

    /** A pong arrived — resolve the in-flight foreground probe, if any. */
    private fun onPong() {
        pendingProbe?.complete(Unit)
    }

    private fun onConnectionDrop() {
        // Every signal ends transport-scoped focus, including a duplicate signal
        // while recovery is already running.
        voice.invalidateCaptureForRoute()
        connectors.sessions.reset()
        lifecycle.teardown()
        clearTransportSessionState()
        if (deriver.status == SdkStatus.RECONNECTING) {
            deriver.connectionLost = true
            return
        }
        lifecycleCancel("transport-drop")
        audio.suspendForReconnect()
        deriver.connectionLost = true
        setStatus(SdkStatus.RECONNECTING)
        scope.launch { reconnectController.runReconnectLoop() }
    }

    private fun onReconnectExhausted() {
        clearTransportSessionState()
        deriver.connectionLost = true
        setStatus(SdkStatus.DISCONNECTED)
    }

    private fun clearTransportSessionState() {
        reestablishingSessionId = null
        reestablishing.value = false
        activationCorrelationDirty = false
        _outboundSessionId.value = null
        when (routePhase) {
            RoutePhase.MINTING, RoutePhase.RECOVERING_MINT -> {
                // Keep the acknowledged draft key until configure resolves it. Even an
                // attachment seen before the lost created frame is not yet our anchor.
                routePhase = RoutePhase.RECOVERING_MINT
                desiredSessionId = null
            }
            RoutePhase.PREPARING_DRAFT -> Unit
            else -> routePhase = if (_currentSessionId.value != null || desiredSessionId != null) RoutePhase.FENCED else RoutePhase.ATTACHED
        }
    }

    private fun resetAmbiguousActivationTransport() {
        if (deriver.status == SdkStatus.ERROR || consumerDisconnected) return
        onConnectionDrop()
    }

    // ── State plumbing — fan-in to connection + timeline ─────────────────────────

    private fun emit() {
        _connection.value = deriver.deriveConnection()
        _timeline.value = deriver.deriveTimeline()
    }

    private fun setStatus(next: SdkStatus) {
        if (deriver.status == next) return
        log.info("status", mapOf("from" to deriver.status, "to" to next))
        deriver.status = next
        refreshStuckWatch() // a drop→RECONNECTING arms it; a reconnect→READY disarms it
        if (next == SdkStatus.READY) {
            deriver.connectionLost = false
            // First READY marks the user "in session" → gate stays on chat.
            // PRESERVED across idle/drop/reconnect; cleared only on logout/authExpired.
            if (!deriver.hasSession) {
                log.info("hasSession.set", mapOf("trigger" to "ready"))
                deriver.hasSession = true
            }
            onReadyReached()
        }
        emit()
    }

    /**
     * READY rising edge. RESUME-AWARE (Task 3.10-mobile, Slice 3).
     *
     * The FIRST READY (first connect) has nothing to restore. Every SUBSEQUENT
     * READY is a reconnect, and its handling depends on whether a resume was
     * attempted (the cursor carries a seq — see [resumeParams], folded INTO the
     * handshake's session.configure, which is sent BEFORE this rising edge):
     *
     *   - resume IN FLIGHT (reconnect + anchor + cursor seq): DEFER. We already
     *     carried resume in configure; do NOT clear-to-idle and do NOT re-activate
     *     here. The gateway's `stream.resumed` ack ([onStreamResumed]) decides: a
     *     recovered:true replay re-establishes the in-flight THINKING/speaking
     *     (preserve it); a recovered:false ack does the A1-equivalent recovery.
     *     This is the bug fix — clearing here would lose the state the resume
     *     exists to preserve (an IDLE flash + a possible watchdog fire).
     *
     *   - NO resume possible (reconnect + anchor but cursor empty, lastSeq==0):
     *     the legacy A1 path — fire-and-forget conversation.activate to restore
     *     the server context + clear stale active UI state to idle. No resume
     *     handshake is possible without a cursor.
     *
     * The gateway ALWAYS answers a stream.resume with a stream.resumed, so the
     * deferred branch resolves reliably; the Slice-1 stuck-state watchdog is the
     * defensive backstop if (against contract) no ack arrives.
     */
    private fun onReadyReached() {
        val wasReconnect = hasReachedReadyOnce
        hasReachedReadyOnce = true
        val anchored = _currentSessionId.value
        if (routePhase == RoutePhase.PREPARING_DRAFT) {
            connectors.sessions.retryPendingMint()
            return
        }
        // Configure resolves a spent draft with attached before ready, or returns
        // the still-unspent draft after ready. Neither path needs conversation.activate.
        if (routePhase == RoutePhase.RECOVERING_MINT || (anchored != null && _outboundSessionId.value == anchored)) return
        if (desiredSessionId != null && desiredSessionId != anchored) {
            log.info("ready.route-transition-pending", mapOf("sessionId" to desiredSessionId))
            return
        }
        // Mirror resumeParams's exact gate: resume was/will be carried in configure
        // iff the cursor carries a seq. Read here so the defer decision matches the wire.
        val resumeWillBeAttempted = resumeCursor.snapshot.lastSeq > 0L
        when (decideOnReady(wasReconnect, anchored != null, resumeWillBeAttempted)) {
            ReadyAction.NOTHING_TO_RESTORE -> {
                log.info("ready.first-connect", mapOf("anchored" to anchored))
                // If a sendNew was fired before the transport was open (pre-READY mint),
                // the session.new frame was silently dropped (null activeTransport). Retry
                // it now so the session.created anchor arrives and flushIfReady can drain.
                if (connectors.sessions.hasPendingMint()) {
                    log.info("ready.first-connect.retry-pending-mint")
                    connectors.sessions.retryPendingMint()
                }
            }
            ReadyAction.NO_ANCHOR ->
                log.info("ready.reconnect.no-anchor")
            ReadyAction.DEFER_TO_RESUME ->
                // resume already carried in session.configure; await stream.resumed.
                log.info("ready.reconnect.defer-to-resume", mapOf("sessionId" to anchored))
            ReadyAction.REESTABLISH_AND_CLEAR -> {
                if (latestActivation != null) {
                    log.info("ready.reconnect.activation-pending", mapOf("sessionId" to latestActivation?.sessionId))
                } else {
                    log.info("ready.reconnect.re-establish", mapOf("sessionId" to anchored))
                    reestablishAnchoredSession(anchored!!)
                    clearActiveToIdle()
                }
            }
        }
    }

    /**
     * Fire the fire-and-forget conversation.activate that re-focuses the gateway's
     * active conversation on the anchored session after a reconnect (the gateway
     * emits session.switched only; the client loads history via REST; the WS
     * preserves frame order so the next user.message routes to the restored
     * session). Shared by the no-resume A1 path ([onReadyReached]) and the
     * recovered:false recovery ([onStreamResumed]).
     */
    private fun reestablishAnchoredSession(sessionId: String) {
        reestablishingSessionId = sessionId
        reestablishing.value = true
        // fireSwitch, NOT sendSwitchSession: the reconnect path must NOT clear
        // cognition here. onReadyReached (REESTABLISH_AND_CLEAR) and onStreamResumed
        // (RECOVER_TO_IDLE) own that decision; the resume PRESERVE path keeps state.
        fireSwitch(sessionId)
    }

    /**
     * Anchor the active ACP session uuid from a session.switched / session.created
     * broadcast. Defensive empty-id guard: the gateway only emits session.switched
     * with a real uuid (session.new emits conversation.snapshot WITHOUT a switched
     * frame), so an empty id should never arrive — but never anchor one if it does.
     *
     * History loading is now fully connector-driven: [ConversationHistoryConnector]
     * fires [SdkConnectors.loadHistoryForSession] directly from its onHistoryNeeded
     * callback AFTER bumping the generation — no ordering dependency here.
     */
    private fun onSessionAttached(sessionId: String) {
        if (routePhase == RoutePhase.RECOVERING_MINT) onSessionAnchored(sessionId)
        if (desiredSessionId == null || desiredSessionId == sessionId) {
            if (routePhase != RoutePhase.MINTING) routePhase = RoutePhase.ATTACHED
            desiredSessionId = sessionId
        }
    }

    private fun onSessionAnchored(sessionId: String) {
        if (sessionId.isEmpty()) {
            log.debug("session.anchor.ignored-empty")
            return
        }
        // A re-establish switch we were awaiting just confirmed.
        if (sessionId == reestablishingSessionId) {
            reestablishingSessionId = null
            reestablishing.value = false
        }
        _outboundSessionId.value = sessionId
        routePhase = RoutePhase.ATTACHED
        acknowledgeRoute(sessionId)
        val isNewSession = _currentSessionId.value != sessionId
        if (isNewSession) {
            log.info("session.anchor", mapOf("sessionId" to sessionId))
            _currentSessionId.value = sessionId
        }
    }

    private fun acknowledgeRoute(sessionId: String) {
        val generation = _outboundRouteGeneration.value ?: return
        _acknowledgedRoute.value = AcknowledgedSessionRoute(sessionId, generation)
    }

    /**
     * `sessions.error forbidden` arrived. If a reconnect re-establish switch is in
     * flight, the anchored session was revoked elsewhere — drop the anchor so the
     * next reconnect does not re-fire a switch to a dead session, and surface a
     * one-shot [SdkEvent.ReopenFailed] so the UI can tell the user the chat could
     * not be reopened (the next send mints a fresh conversation). A forbidden with
     * no re-establish in flight is unrelated (e.g. an explicit op) and left alone.
     */
    private fun onSessionUnavailable() {
        val pending = reestablishingSessionId ?: return
        log.info("session.anchor.cleared-unavailable", mapOf("sessionId" to pending))
        clearTransportSessionState()
        _currentSessionId.value = null
        routePhase = RoutePhase.ATTACHED
        log.info("event.reopen-failed", mapOf("sessionId" to pending))
        emitEvent(SdkEvent.ReopenFailed)
    }

    // ── Resume handshake (Task 3.10) ─────────────────────────────────────────────

    /**
     * Apply the resume cursor to every decoded frame (control + peeled binary).
     * Returns true if the frame should be processed; false to DROP it as a replay
     * duplicate. seq==0 frames always pass (no seq stamp). Called from the pump
     * BEFORE routing so deduped replays never reach the connectors.
     *
     * On a real advance (the cursor moved forward) note it on [cursorPersistence] so
     * the next turn boundary persists the snapshot (Task 4.7 save coalescing).
     */
    private fun applyCursor(seq: Long, epoch: Long?): Boolean {
        val before = resumeCursor.snapshot
        val applied = resumeCursor.tryApply(seq, epoch)
        if (resumeCursor.snapshot != before) cursorPersistence.noteAdvance()
        return applied
    }

    /**
     * Build the resume params to fold INTO `session.configure` on a RECONNECT.
     *
     * SEED (Task 4.7): if the in-memory cursor is empty (a fresh app launch within the
     * gateway's replay-buffer TTL) AND a conversation is anchored, [cursorPersistence]
     * seeds it from durable storage so a relaunch sends a real resume (→ recovered:true,
     * replay the gap) instead of recovered:false (reset + full REST refetch).
     *
     * Null only when there is STILL no seq after the seed attempt (first ever connect
     * for this conversation, or after a non-recovered reset) → configure omits resume
     * and the gateway runs the fresh path. Mirrors web-sdk buildConfigureResume.
     */
    private fun resumeParams(): ResumeParams? {
        if (desiredSessionId != null && desiredSessionId != _currentSessionId.value) return null
        cursorPersistence.seedIfEmpty()
        val (epoch, lastSeq) = resumeCursor.snapshot
        if (lastSeq == 0L) {
            log.debug("configure.resume.skip-no-cursor")
            return null
        }
        log.info("configure.resume.attached", mapOf("epoch" to epoch, "lastSeq" to lastSeq))
        return ResumeParams(epoch = epoch, lastSeq = lastSeq)
    }

    /**
     * React to `stream.resumed` from the gateway (Task 3.10). RESUME-AWARE — the
     * deferred half of the A1-vs-resume reconciliation ([onReadyReached] deferred
     * the clear/activate decision to here).
     *
     * recovered=true → PRESERVE in-flight state. The gateway replayed the in-flight
     *   turn's frames; the cursor dedups them and they re-establish THINKING/
     *   speaking. We must NOT clear cognition/isSpeaking — that is the whole point
     *   of the resume. No-op beyond confirming the recovery.
     *
     * recovered=false → the gateway could NOT resume (epoch rolled over / buffer
     *   expired). Do the A1-equivalent recovery NOW: reset the cursor, clear stale
     *   active UI state to idle, REST-refetch history, and (if a session is
     *   anchored) re-fire conversation.activate to re-focus the gateway's active
     *   conversation — exactly what the old unconditional A1 path did, but deferred
     *   to ack time so the recovered:true case can preserve state instead.
     */
    private fun onStreamResumed(recovered: Boolean) {
        when (decideOnResumed(recovered)) {
            ResumedAction.PRESERVE_IN_FLIGHT -> {
                val anchored = _currentSessionId.value
                if (desiredSessionId == null || desiredSessionId == anchored) {
                    _outboundSessionId.value = anchored
                    routePhase = RoutePhase.ATTACHED
                }
                log.info("stream.resumed.recovered", mapOf("epoch" to resumeCursor.snapshot.epoch))
            }
            ResumedAction.RECOVER_TO_IDLE -> {
                log.info("stream.resumed.not-recovered — clear-to-idle + refetch + re-establish")
                resumeCursor.reset()
                // The gateway could not resume → the persisted cursor is stale. Drop
                // it (Task 4.7 clear) so the NEXT relaunch doesn't re-seed a dead epoch.
                cursorPersistence.clearAnchored()
                clearActiveToIdle()
                if (latestActivation != null) {
                    log.info("stream.resumed.activation-pending", mapOf("sessionId" to latestActivation?.sessionId))
                    return
                }
                val sessionId = _currentSessionId.value
                if (sessionId == null) {
                    log.warn("stream.resumed.no-session — cannot refetch")
                    return
                }
                connectors.refetchHistoryForSession(sessionId)
                reestablishAnchoredSession(sessionId)
            }
        }
    }

    private fun setError(authExpired: Boolean) {
        cancelSessionActivations()
        connectors.sessions.reset()
        clearTransportSessionState()
        deriver.authExpired = authExpired
        // Terminal auth failure ends the session → gate falls back to login.
        // Idle/drop never route here, so hasSession survives those by construction.
        if (authExpired && deriver.hasSession) {
            log.info("hasSession.clear", mapOf("trigger" to "authExpired"))
            deriver.hasSession = false
        }
        setStatus(SdkStatus.ERROR)
    }

    /**
     * Engagement bookkeeping hook. Currently a no-op — retained because the
     * forthcoming ensureConnected()/presence work will record interaction here,
     * and the send/interrupt call sites already invoke it.
     */
    private fun markInteraction() {
    }

    /**
     * Fire-and-forget control frame. Silently drops if no active transport exists (pre-READY).
     * Callers that need guaranteed delivery must defer until READY or use the pending-mint retry.
     */
    private fun canSendUserInput(): Boolean = !consumerDisconnected && !terminallyDisconnected && !routeFenced &&
        (desiredSessionId == null || _outboundSessionId.value == desiredSessionId)

    private fun canSendCommand(msg: ClientMessage): Boolean = when (msg) {
        is ClientMessage.Auth, is ClientMessage.SessionConfigure, is ClientMessage.Ping,
        is ClientMessage.ConversationActivate, is ClientMessage.SessionNew, is ClientMessage.UserPreferencesPatch -> true
        is ClientMessage.TextInput, is ClientMessage.AudioStart -> canSendUserInput()
        else -> !routeFenced
    }

    private fun noteUserInput(msg: ClientMessage) {
        if (routePhase == RoutePhase.DRAFT && (msg is ClientMessage.TextInput || msg is ClientMessage.AudioStart)) {
            routePhase = RoutePhase.MINTING
        }
    }

    private fun sendControl(msg: ClientMessage) {
        if (!canSendCommand(msg)) return
        if (msg is ClientMessage.SessionNew && routePhase == RoutePhase.PREPARING_DRAFT) draftRequestId = msg.requestId
        val tx = lifecycle.activeTransport ?: return
        val generation = _outboundRouteGeneration.value
        scope.launch {
            if (tx !== lifecycle.activeTransport || generation != _outboundRouteGeneration.value || !canSendCommand(msg)) return@launch
            noteUserInput(msg)
            tx.send(msg)
        }
    }

    private suspend fun sendControlAwaited(msg: ClientMessage) {
        val tx = lifecycle.activeTransport ?: throw SessionsTransportException()
        if (!canSendCommand(msg)) throw SessionsTransportException()
        try {
            noteUserInput(msg)
            tx.send(msg)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            throw SessionsTransportException()
        }
    }

    private fun sendBinary(bytes: ByteArray) {
        if (!canSendUserInput()) return
        val tx = lifecycle.activeTransport ?: return
        val generation = _outboundRouteGeneration.value
        scope.launch {
            if (tx === lifecycle.activeTransport && generation == _outboundRouteGeneration.value && canSendUserInput()) tx.sendBinary(bytes)
        }
    }

    private fun mergedCapabilities(): List<String> =
        (config.capabilities + connectors.capabilities + STREAM_RESUME_CAPABILITY).distinct()

    // ── Lifecycle callbacks ──────────────────────────────────────────────────────

    private inner class Hooks : LifecycleHooks {
        override fun setStatus(next: SdkStatus) = this@SentientSdk.setStatus(next)
        override fun onReady(sessionId: String) { /* tunables folded in lifecycle */ }
        override fun onTransportDetached() {
            clearTransportSessionState()
            _transportGeneration.value += 1
        }
        override fun isRouteFenced(): Boolean = routeFenced
        override fun onSessionAttached(sessionId: String) = this@SentientSdk.onSessionAttached(sessionId)
        override fun shouldRouteSessionFrame(msg: ServerMessage, sessionId: String): Boolean {
            if (routePhase == RoutePhase.RECOVERING_MINT) {
                // Only this reconnect's configure response can resolve our anchored
                // draft. Old transports are detached; new route intents leave this phase.
                return when (msg) {
                    is ServerMessage.SessionAttached -> deriver.status == SdkStatus.AUTHENTICATING && _currentSessionId.value != null
                    is ServerMessage.SessionDraft -> msg.requestId == null && sessionId == _currentSessionId.value
                    else -> false
                }
            }
            if (routePhase == RoutePhase.PREPARING_DRAFT) {
                return msg is ServerMessage.SessionDraft && draftRequestId != null && msg.requestId == draftRequestId
            }
            if (routePhase == RoutePhase.DRAFT && msg !is ServerMessage.SessionDraft) return false
            if (routePhase == RoutePhase.MINTING && (msg is ServerMessage.SessionDraft || msg is ServerMessage.SessionSwitched)) return false
            // An activation's attachment/reconstruction is not a mint completion.
            if (msg is ServerMessage.SessionCreated && desiredSessionId != null &&
                _outboundSessionId.value == null && routePhase != RoutePhase.MINTING) return false
            if (msg is ServerMessage.SessionDraft && msg.requestId != null && msg.requestId != draftRequestId) return false
            val desired = desiredSessionId
            if (desired != null && desired != sessionId) return false
            val latest = latestActivation
            if (latest?.sessionId == sessionId) {
                staleActivationIds -= sessionId
                return true
            }
            if (latest != null) return false
            return sessionId !in staleActivationIds
        }
        override fun onDiscardedSessionSwitched(sessionId: String) {
            staleActivationIds -= sessionId
            connectors.sessions.acknowledgeIgnoredSwitch(sessionId)
            if (sessionId == reestablishingSessionId) {
                reestablishingSessionId = null
                reestablishing.value = false
            }
        }
        override fun hasInFlightActivation(): Boolean = inFlightActivation != null
        override fun onSessionAnchored(sessionId: String) = this@SentientSdk.onSessionAnchored(sessionId)
        override fun onDraftAnchored(draftKey: String) {
            onSessionAnchored(draftKey)
            routePhase = RoutePhase.DRAFT
            desiredSessionId = null
        }
        override fun onSessionUnavailable() = this@SentientSdk.onSessionUnavailable()
        override fun onPong() = this@SentientSdk.onPong()
        override fun onStreamResumed(recovered: Boolean) = this@SentientSdk.onStreamResumed(recovered)
        override fun onTurnSettled() = cursorPersistence.flush()
        override fun resumeParams(): ResumeParams? = this@SentientSdk.resumeParams()
        override fun currentConversationId(): String? = _currentSessionId.value.takeIf {
            desiredSessionId == null || desiredSessionId == it
        }
        override fun onAuthFailed() = setError(authExpired = true)
        override fun onConnectionDrop() = this@SentientSdk.onConnectionDrop()
        override fun mergedCapabilities(): List<String> = this@SentientSdk.mergedCapabilities()
        override fun token(): String = bundle.tokenStore.load() ?: ""
        override fun nowMs(): Long = bundle.clock.nowMs()
        override fun isConsumerDisconnected(): Boolean = consumerDisconnected
        override fun status(): SdkStatus = deriver.status
    }

    companion object {
        /** Back-pressure buffer depth for the events SharedFlow. */
        const val EVENTS_BUFFER_CAPACITY = 256

        /** Capability advertised so the gateway enables the seq/epoch resume handshake (Task 3.10). */
        const val STREAM_RESUME_CAPABILITY = "stream.resume"
    }
}
