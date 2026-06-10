// ---------------------------------------------------------------------------
// SentientSdk — THE orchestrator. Wires transport + connectors + handshake +
// reconnect + idle into the split observable surfaces:
//   connection: StateFlow<ConnectionState>  — transport + voice axis
//   timeline:   StateFlow<List<ChatMessage>> — committed message history
//   events:     SharedFlow<SdkEvent>         — one-shot notifications
// Mirrors web-sdk sentient-sdk.ts. Split across: StateDeriver, Handshake,
// SdkConnectors, SdkLifecycle. This file owns the public surface + state plumbing.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.FaultAwareCaptureAdapter
import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.SessionsListPage
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.presence.IdleDetectorConfig
import io.sentient.mobilesdk.presence.IdleDetectorEvent
import io.sentient.mobilesdk.presence.createIdleDetector
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ResumeParams
import io.sentient.mobilesdk.protocol.SdkEvent
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.random.Random

private const val DEFAULT_SESSIONS_TIMEOUT_MS = 5_000L
private const val DEFAULT_IDLE_THRESHOLD_MS = 3_600_000L
private const val DEFAULT_IDLE_TICK_MS = 30_000L

/** A1: "stuck" only when a cycle is active AND the socket is not healthy. A slow healthy
 *  cycle stays READY and never arms — no content-frame false-positives. */
internal fun shouldWatchStuck(cognition: CognitionState, isSpeaking: Boolean, status: SdkStatus): Boolean =
    (cognition != CognitionState.IDLE || isSpeaking) && status != SdkStatus.READY

class SentientSdk(
    private val config: SdkConfig,
    private val bundle: PlatformBundle,
    private val scope: CoroutineScope,
    newId: () -> String = { Random.nextLong().toString(16) },
    private val delayFn: suspend (Long) -> Unit = { delay(it) },
    sessionsTimeoutMs: Long = DEFAULT_SESSIONS_TIMEOUT_MS,
    idleThresholdMs: Long = DEFAULT_IDLE_THRESHOLD_MS,
    idleTickMs: Long = DEFAULT_IDLE_TICK_MS,
    /** REST client for session queries. Null in tests that don't exercise REST. */
    sessionsHttpClient: SessionsHttpClient? = null,
    /**
     * Durable resume-cursor persistence (Task 4.7). Dependency-inverted: the SDK
     * defines the interface; mobile-data backs it with the SyncCursorStore. Defaults
     * to a no-op so existing construction + tests that don't exercise persistence
     * still build. Seeds the in-memory cursor on resume-prep, persists on advance
     * (coalesced to cycle boundaries), clears on a non-recovered reset / delete.
     */
    private val resumeCursorStore: ResumeCursorStore = NoOpResumeCursorStore,
) {
    private val log = createLogger("sdk", "orchestrator")

    private val _connection = MutableStateFlow(ConnectionState())
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _timeline = MutableStateFlow<List<ChatMessage>>(emptyList())
    val timeline: StateFlow<List<ChatMessage>> = _timeline.asStateFlow()

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
    private val idle = createIdleDetector(IdleDetectorConfig(idleThresholdMs = idleThresholdMs))
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
    // session.switched lands. A `forbidden` while this is non-null means the
    // anchored session was revoked → drop the anchor (see onSessionForbidden).
    private var reestablishingSessionId: String? = null

    // FaultHooks declared early so effectiveCapture + lifecycle can both reference it.
    private val faultHooks = FaultHooks()

    // Resume cursor (Task 3.10): tracks seq/epoch so replayed frames dedup and the
    // reconnect stream.resume carries the right {epoch,lastSeq}. The SDK owns it;
    // WsTransport peels the header + emits seq, the pump applies the cursor (mirrors
    // the web split). Task 4.7 persists it durably via [cursorPersistence].
    private val resumeCursor = ResumeCursor()

    // Task 4.7 durable persistence: seeds the empty cursor on resume-prep, persists
    // on advance (coalesced to cycle boundaries), clears on a non-recovered reset /
    // delete. Keyed by the live currentSessionId so it never holds a stale anchor.
    private val cursorPersistence = ResumeCursorPersistence(
        cursor = resumeCursor,
        store = resumeCursorStore,
        conversationId = { _currentSessionId.value },
    )

    // Stable per-install device id (Task 3.10). Resolved ONCE — the gateway requires
    // it in session.configure and keys the per-device replay buffer by it.
    private val deviceId: String = DeviceIdProvider(bundle.deviceIdStore).getOrCreate()

    // Voice pipeline (E3). Built BEFORE connectors so the downlink hooks exist
    // when the connector set reads them; the pipeline reaches connectors.audioInput
    // via a lazy lambda to break the construction cycle. See SdkAudio.
    //
    // In debug builds, wrap the real capture adapter with FaultAwareCaptureAdapter
    // so loadFixtureUtterance() can inject a pre-recorded PCM utterance instead of
    // live mic audio. Null capture passes through unchanged (text-only path).
    private val effectiveCapture = if (config.devFaultsEnabled && bundle.capture != null) {
        FaultAwareCaptureAdapter(real = bundle.capture, faultHooks = faultHooks)
    } else {
        bundle.capture
    }

    private val audio: SdkAudio = SdkAudio(
        audioConfig = config.audio,
        capture = effectiveCapture,
        playback = bundle.playback,
        audioInput = { connectors.audioInput },
        clock = bundle.clock,
        scope = scope,
        onStateChanged = ::onAudioStateChanged,
        onBargeIn = { cycleId -> connectors.cycleError.noteBargeIn(cycleId) },
    )

    private val connectors = SdkConnectors(
        deriver = deriver,
        emit = ::emit,
        emitEvent = ::emitEvent,
        send = ::sendControl,
        sendBinary = ::sendBinary,
        newId = newId,
        sessionsTimeoutMs = sessionsTimeoutMs,
        clock = bundle.clock,
        mintDebounceMs = config.mintDebounceMs,
        sessionsHttpClient = sessionsHttpClient,
        scope = scope,
        audioHooks = { audio.downlinkHooks },
        onCognitionChanged = ::onCognitionChanged,
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

    private fun clearActiveToIdle() {
        connectors.cognition.reset()  // currentState→IDLE + onCognitionChanged → deriver IDLE + refreshStuckWatch + emit
        audio.stopLocal()             // isSpeaking→false (if speaking) via onAudioStateChanged
        stuckWatchdog.disarm()
        emit()
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
        idle = idle,
        idleTickMs = idleTickMs,
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
     *   the hasSession slice so the gate falls back to login. false (idle-
     *   disconnect via [Hooks.disconnectForIdle]) keeps the user "in session"
     *   (gate stays on chat; SDK auto-reconnects on the next presence signal).
     */
    fun disconnect(clearSession: Boolean = true) {
        log.info("disconnect", mapOf("clearSession" to clearSession))
        consumerDisconnected = true
        reconnectController.cancel()
        connectors.sessions.reset()
        // Terminal teardown (logout) frees the native codecs; a transient disconnect
        // (idle, reconnect) keeps them so TTS survives the next reconnect.
        if (clearSession) audio.dispose() else audio.suspendForReconnect()
        lifecycle.teardown()
        if (clearSession && deriver.hasSession) {
            log.info("hasSession.clear", mapOf("trigger" to "logout"))
            deriver.hasSession = false
        }
        if (clearSession) {
            log.info("session.anchor.clear", mapOf("trigger" to "logout"))
            _currentSessionId.value = null
            reestablishingSessionId = null
        }
        setStatus(SdkStatus.DISCONNECTED)
        stuckWatchdog.disarm()
    }

    /** Send user text (text.input). Mirrors web-sdk sendText. */
    fun sendText(text: String, pendingId: String? = null) {
        markInteraction()
        connectors.text.sendText(text, pendingId)
    }

    /** UI Stop / Escape — idempotent hard interrupt. Fire-and-forget: clears local
     *  UI state immediately, never waits for a server ack (a dead socket sends none). */
    fun interrupt() {
        log.info("interrupt")
        markInteraction()
        connectors.cycleError.noteInterrupt(null)
        clearActiveToIdle()
        sendControl(ClientMessage.Interrupt) // best-effort; null-safe if transport is dead
    }

    /**
     * Start the voice uplink (E3): flip voiceMode ACTIVE, send audio.start, run the
     * capture→EchoGate→pre-roll→uplink pipeline on the scope. Mirrors webui
     * startVoiceMode — stream continuously, gate out echo, let the server VAD.
     */
    fun startMic() {
        log.info("startMic", mapOf("captureWired" to (bundle.capture != null)))
        markInteraction()
        deriver.voiceMode = VoiceMode.ACTIVE
        connectors.audioInput.startStreaming()
        audio.startUplink()
        emit()
    }

    /**
     * Stop the voice uplink (E3): send audio.end, stop the pipeline (cancel collect
     * + capture.stop + reset onset; FSM → INACTIVE), flip voiceMode OFF.
     */
    fun stopMic() {
        log.info("stopMic")
        deriver.voiceMode = VoiceMode.OFF
        connectors.audioInput.stopStreaming()
        audio.stopUplink()
        emit()
    }

    /** Patch TTS on/off; server echoes via session.preferences.changed. */
    suspend fun setTtsEnabled(enabled: Boolean) {
        log.info("setTtsEnabled", mapOf("enabled" to enabled))
        connectors.preferences.patch(AudioPreferencesPatch(ttsEnabled = enabled))
    }

    /** Page the session list via REST GET /api/v1/sessions. */
    @Throws(kotlin.coroutines.cancellation.CancellationException::class)
    suspend fun listSessions(limit: Int, offset: Int): SessionsListPage =
        connectors.sessions.list(limit, offset)

    /** Switch to a session; awaits the session.switched broadcast. */
    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun switchSession(sessionId: String) {
        markInteraction()
        connectors.cycleError.reset()
        connectors.sessions.switchTo(sessionId)
    }

    /** Start a fresh chat; awaits the session.created broadcast. */
    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun newChat(): String {
        markInteraction()
        connectors.cycleError.reset()
        return connectors.sessions.newChat()
    }

    /**
     * Fire-and-forget new chat (A2). Sends session.new and returns immediately —
     * the gateway emits session.switched + empty snapshot now, then session.created
     * after the slow ACP mint. NEVER awaits, NEVER throws. The UI must not block on
     * a session round-trip. Debounced in the connector so rapid taps mint once.
     */
    fun sendNewChat() {
        markInteraction()
        connectors.cycleError.reset()
        connectors.sessions.sendNew()
    }

    /**
     * Fire-and-forget switch (A2). Sends conversation.activate and returns immediately —
     * the gateway emits session.switched only; the client loads history via REST.
     * NEVER awaits, NEVER throws. Used both by the UI and by the reconnect re-establish (A1).
     */
    fun sendSwitchSession(id: String) {
        markInteraction()
        connectors.cycleError.reset()
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
        // Guard against a second loop: a non-clean signal may arrive while the
        // loop launched by a prior drop is already recovering.
        if (deriver.status == SdkStatus.RECONNECTING) {
            deriver.connectionLost = true
            return
        }
        deriver.connectionLost = true
        setStatus(SdkStatus.RECONNECTING)
        scope.launch { reconnectController.runReconnectLoop() }
    }

    private fun onReconnectExhausted() {
        deriver.connectionLost = true
        setStatus(SdkStatus.DISCONNECTED)
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
        // Mirror resumeParams's exact gate: resume was/will be carried in configure
        // iff the cursor carries a seq. Read here so the defer decision matches the wire.
        val resumeWillBeAttempted = resumeCursor.snapshot.lastSeq > 0L
        when (decideOnReady(wasReconnect, anchored != null, resumeWillBeAttempted)) {
            ReadyAction.NOTHING_TO_RESTORE ->
                log.info("ready.first-connect", mapOf("anchored" to anchored))
            ReadyAction.NO_ANCHOR ->
                log.info("ready.reconnect.no-anchor")
            ReadyAction.DEFER_TO_RESUME ->
                // resume already carried in session.configure; await stream.resumed.
                log.info("ready.reconnect.defer-to-resume", mapOf("sessionId" to anchored))
            ReadyAction.REESTABLISH_AND_CLEAR -> {
                log.info("ready.reconnect.re-establish", mapOf("sessionId" to anchored))
                reestablishAnchoredSession(anchored!!)
                clearActiveToIdle()
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
        sendSwitchSession(sessionId)
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
    private fun onSessionAnchored(sessionId: String) {
        if (sessionId.isEmpty()) {
            log.debug("session.anchor.ignored-empty")
            return
        }
        // A re-establish switch we were awaiting just confirmed.
        if (sessionId == reestablishingSessionId) reestablishingSessionId = null
        val isNewSession = _currentSessionId.value != sessionId
        if (isNewSession) {
            log.info("session.anchor", mapOf("sessionId" to sessionId))
            _currentSessionId.value = sessionId
        }
    }

    /**
     * `sessions.error forbidden` arrived. If a reconnect re-establish switch is in
     * flight, the anchored session was revoked elsewhere — drop the anchor so the
     * next reconnect does not re-fire a switch to a dead session. A forbidden with
     * no re-establish in flight is unrelated (e.g. an explicit op) and left alone.
     */
    private fun onSessionForbidden() {
        val pending = reestablishingSessionId ?: return
        log.info("session.anchor.cleared-forbidden", mapOf("sessionId" to pending))
        reestablishingSessionId = null
        _currentSessionId.value = null
    }

    // ── Resume handshake (Task 3.10) ─────────────────────────────────────────────

    /**
     * Apply the resume cursor to every decoded frame (control + peeled binary).
     * Returns true if the frame should be processed; false to DROP it as a replay
     * duplicate. seq==0 frames always pass (no seq stamp). Called from the pump
     * BEFORE routing so deduped replays never reach the connectors.
     *
     * On a real advance (the cursor moved forward) note it on [cursorPersistence] so
     * the next cycle boundary persists the snapshot (Task 4.7 save coalescing).
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
     *   cycle's frames; the cursor dedups them and they re-establish THINKING/
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
            ResumedAction.PRESERVE_IN_FLIGHT ->
                log.info("stream.resumed.recovered", mapOf("epoch" to resumeCursor.snapshot.epoch))
            ResumedAction.RECOVER_TO_IDLE -> {
                log.info("stream.resumed.not-recovered — clear-to-idle + refetch + re-establish")
                resumeCursor.reset()
                // The gateway could not resume → the persisted cursor is stale. Drop
                // it (Task 4.7 clear) so the NEXT relaunch doesn't re-seed a dead epoch.
                cursorPersistence.clearAnchored()
                clearActiveToIdle()
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
        deriver.authExpired = authExpired
        // Terminal auth failure ends the session → gate falls back to login.
        // Idle/drop never route here, so hasSession survives those by construction.
        if (authExpired && deriver.hasSession) {
            log.info("hasSession.clear", mapOf("trigger" to "authExpired"))
            deriver.hasSession = false
        }
        setStatus(SdkStatus.ERROR)
    }

    private fun markInteraction() {
        idle.handle(IdleDetectorEvent.Interaction(bundle.clock.nowMs()))
    }

    private fun sendControl(msg: ClientMessage) {
        scope.launch { lifecycle.activeTransport?.send(msg) }
    }

    private fun sendBinary(bytes: ByteArray) {
        scope.launch { lifecycle.activeTransport?.sendBinary(bytes) }
    }

    private fun mergedCapabilities(): List<String> =
        (config.capabilities + connectors.capabilities + STREAM_RESUME_CAPABILITY).distinct()

    // ── Lifecycle callbacks ──────────────────────────────────────────────────────

    private inner class Hooks : LifecycleHooks {
        override fun setStatus(next: SdkStatus) = this@SentientSdk.setStatus(next)
        override fun onReady(sessionId: String) { /* tunables folded in lifecycle */ }
        override fun onSessionAnchored(sessionId: String) = this@SentientSdk.onSessionAnchored(sessionId)
        override fun onSessionForbidden() = this@SentientSdk.onSessionForbidden()
        override fun onPong() = this@SentientSdk.onPong()
        override fun onStreamResumed(recovered: Boolean) = this@SentientSdk.onStreamResumed(recovered)
        override fun onCycleSettled() = cursorPersistence.flush()
        override fun resumeParams(): ResumeParams? = this@SentientSdk.resumeParams()
        override fun onAuthFailed() = setError(authExpired = true)
        override fun onConnectionDrop() = this@SentientSdk.onConnectionDrop()
        override fun mergedCapabilities(): List<String> = this@SentientSdk.mergedCapabilities()
        override fun token(): String = bundle.tokenStore.load() ?: ""
        override fun nowMs(): Long = bundle.clock.nowMs()
        override fun isConsumerDisconnected(): Boolean = consumerDisconnected
        override fun status(): SdkStatus = deriver.status
        // Idle-disconnect keeps hasSession=true: the user stays "in session" and
        // the SDK auto-reconnects on the next presence signal. Only explicit
        // logout (the default disconnect()) clears the session.
        override fun disconnectForIdle() = disconnect(clearSession = false)
    }

    companion object {
        /** Back-pressure buffer depth for the events SharedFlow. */
        const val EVENTS_BUFFER_CAPACITY = 256

        /** Capability advertised so the gateway enables the seq/epoch resume handshake (Task 3.10). */
        const val STREAM_RESUME_CAPABILITY = "stream.resume"
    }
}
