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
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.transport.ConnectResult
import io.sentient.mobilesdk.transport.MessageRouter
import io.sentient.mobilesdk.transport.ReconnectController
import io.sentient.mobilesdk.transport.SdkStatus
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
import kotlin.random.Random

private const val DEFAULT_SESSIONS_TIMEOUT_MS = 5_000L
private const val DEFAULT_IDLE_THRESHOLD_MS = 3_600_000L
private const val DEFAULT_IDLE_TICK_MS = 30_000L

class SentientSdk(
    private val config: SdkConfig,
    private val bundle: PlatformBundle,
    private val scope: CoroutineScope,
    newId: () -> String = { Random.nextLong().toString(16) },
    private val delayFn: suspend (Long) -> Unit = { delay(it) },
    sessionsTimeoutMs: Long = DEFAULT_SESSIONS_TIMEOUT_MS,
    idleThresholdMs: Long = DEFAULT_IDLE_THRESHOLD_MS,
    idleTickMs: Long = DEFAULT_IDLE_TICK_MS,
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

    // The active ACP session uuid, anchored ONLY from session.switched /
    // session.created broadcasts (non-empty ids). Drives the reconnect re-
    // establish (fire session.switch on a reconnect READY to restore server
    // context) and is cleared on consumer disconnect(clearSession = true).
    // NOT a persistent connect-URL resume — see Task A1.
    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    // True once the SDK has reached READY at least once on this orchestrator.
    // Distinguishes a RECONNECT-READY (re-establish the anchored session) from
    // the FIRST connect-READY (nothing to restore). Never reset — survives
    // idle/drop/reconnect, matching hasSession.
    private var hasReachedReadyOnce = false

    // The session id a reconnect re-establish switch is currently awaiting
    // confirmation for. Set when the re-establish switch fires; cleared when its
    // session.switched lands. A `forbidden` while this is non-null means the
    // anchored session was revoked → drop the anchor (see onSessionForbidden).
    private var reestablishingSessionId: String? = null

    // FaultHooks declared early so effectiveCapture + lifecycle can both reference it.
    private val faultHooks = FaultHooks()

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
        audioHooks = { audio.downlinkHooks },
    )

    private val router = MessageRouter(connectors.all, audioConnector = connectors.audioOutput)

    private fun onAudioStateChanged(isSpeaking: Boolean, fsmState: AudioState) {
        deriver.isSpeaking = isSpeaking
        deriver.audioState = fsmState
        emit()
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
        router = router,
        idle = idle,
        idleTickMs = idleTickMs,
        delayFn = delayFn,
        hooks = Hooks(),
        log = createLogger("sdk", "lifecycle"),
        handshakeLog = createLogger("sdk", "handshake"),
        onProtocolError = { err -> emitEvent(SdkEvent.ProtocolError(err)) },
        faultHooks = if (config.devFaultsEnabled) faultHooks else null,
    )

    // ── Public surface ───────────────────────────────────────────────────────

    /** Debug-only fault hooks; null unless config.devFaultsEnabled. Consulted at boundaries in Phase 5. */
    fun devFaults(): FaultHooks? = if (config.devFaultsEnabled) faultHooks else null

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
        audio.release()
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
    }

    /** Send user text (text.input). Mirrors web-sdk sendText. */
    fun sendText(text: String, pendingId: String? = null) {
        markInteraction()
        connectors.text.sendText(text, pendingId)
    }

    /** UI Stop / Escape — idempotent hard interrupt. */
    fun interrupt() {
        log.info("interrupt")
        markInteraction()
        // Mark the active cycle's abort as self-initiated BEFORE the wire interrupt
        // so the resulting cycle.aborted is never misread as an unsolicited error.
        connectors.cycleError.noteInterrupt(null)
        sendControl(ClientMessage.Interrupt)
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

    /** Page the session list (requestId-correlated). */
    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
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
     * Fire-and-forget switch (A2). Sends session.switch and returns immediately —
     * the gateway emits session.switched + the session's snapshot. NEVER awaits,
     * NEVER throws. Used both by the UI and by the reconnect re-establish (A1).
     */
    fun sendSwitchSession(id: String) {
        markInteraction()
        connectors.cycleError.reset()
        connectors.sessions.sendSwitch(id)
    }

    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun deleteSession(id: String) = connectors.sessions.delete(id)

    @Throws(
        SessionsRequestException::class,
        SessionsTimeoutException::class,
        kotlin.coroutines.cancellation.CancellationException::class,
    )
    suspend fun renameSession(id: String, title: String) = connectors.sessions.rename(id, title)

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
     * READY rising edge. The FIRST READY (first connect) has nothing to restore.
     * Every SUBSEQUENT READY is a reconnect: if a session is anchored, fire a
     * fire-and-forget session.switch to restore the server context (the gateway
     * re-emits switched + snapshot; the WS preserves frame order so the next
     * user.message routes to the restored session).
     */
    private fun onReadyReached() {
        val wasReconnect = hasReachedReadyOnce
        hasReachedReadyOnce = true
        val anchored = _currentSessionId.value
        if (!wasReconnect) {
            log.info("ready.first-connect", mapOf("anchored" to anchored))
            return
        }
        if (anchored == null) {
            log.info("ready.reconnect.no-anchor")
            return
        }
        log.info("ready.reconnect.re-establish", mapOf("sessionId" to anchored))
        reestablishingSessionId = anchored
        sendSwitchSession(anchored)
    }

    /**
     * Anchor the active ACP session uuid from a session.switched / session.created
     * broadcast. Defensive empty-id guard: the gateway only emits session.switched
     * with a real uuid (session.new emits conversation.snapshot WITHOUT a switched
     * frame), so an empty id should never arrive — but never anchor one if it does.
     */
    private fun onSessionAnchored(sessionId: String) {
        if (sessionId.isEmpty()) {
            log.debug("session.anchor.ignored-empty")
            return
        }
        // A re-establish switch we were awaiting just confirmed.
        if (sessionId == reestablishingSessionId) reestablishingSessionId = null
        if (_currentSessionId.value == sessionId) return
        log.info("session.anchor", mapOf("sessionId" to sessionId))
        _currentSessionId.value = sessionId
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
        (config.capabilities + connectors.capabilities).distinct()

    // ── Lifecycle callbacks ──────────────────────────────────────────────────────

    private inner class Hooks : LifecycleHooks {
        override fun setStatus(next: SdkStatus) = this@SentientSdk.setStatus(next)
        override fun onReady(sessionId: String) { /* tunables folded in lifecycle */ }
        override fun onSessionAnchored(sessionId: String) = this@SentientSdk.onSessionAnchored(sessionId)
        override fun onSessionForbidden() = this@SentientSdk.onSessionForbidden()
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
    }
}
