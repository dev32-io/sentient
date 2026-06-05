// ---------------------------------------------------------------------------
// SentientSdk — THE orchestrator. Wires transport + connectors + handshake +
// reconnect + idle into ONE observable StateFlow<SdkState> (R5).
// Mirrors web-sdk sentient-sdk.ts. Split across: StateDeriver, Handshake,
// SdkConnectors, SdkLifecycle. This file owns the public surface + state plumbing.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsListPage
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.presence.IdleDetectorConfig
import io.sentient.mobilesdk.presence.IdleDetectorEvent
import io.sentient.mobilesdk.presence.createIdleDetector
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.transport.ConnectResult
import io.sentient.mobilesdk.transport.MessageRouter
import io.sentient.mobilesdk.transport.ReconnectController
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.SessionResume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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

    private val _state = MutableStateFlow(SdkState())
    val state: StateFlow<SdkState> = _state.asStateFlow()

    private val deriver = StateDeriver(bundle.clock)
    private val resume = SessionResume(bundle.sessionIdStore, bundle.clock)
    private val idle = createIdleDetector(IdleDetectorConfig(idleThresholdMs = idleThresholdMs))

    // Voice pipeline (E3). Built BEFORE connectors so the downlink hooks exist
    // when the connector set reads them; the pipeline reaches connectors.audioInput
    // via a lazy lambda to break the construction cycle. See SdkAudio.
    private val audio: SdkAudio = SdkAudio(
        audioConfig = config.audio,
        capture = bundle.capture,
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
        send = ::sendControl,
        sendBinary = ::sendBinary,
        newId = newId,
        sessionsTimeoutMs = sessionsTimeoutMs,
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
        resume = resume,
        idle = idle,
        idleTickMs = idleTickMs,
        delayFn = delayFn,
        hooks = Hooks(),
        log = createLogger("sdk", "lifecycle"),
        handshakeLog = createLogger("sdk", "handshake"),
    )

    // ── Public surface ───────────────────────────────────────────────────────

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

    /** Tear down the WS + all loops. Idempotent. Status → DISCONNECTED. */
    fun disconnect() {
        log.info("disconnect")
        consumerDisconnected = true
        reconnectController.cancel()
        connectors.sessions.reset()
        audio.release()
        lifecycle.teardown()
        setStatus(SdkStatus.DISCONNECTED)
    }

    /** Send user text (text.input). Mirrors web-sdk sendText. */
    fun sendText(text: String) {
        markInteraction()
        connectors.text.sendText(text)
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
    suspend fun newChat() {
        markInteraction()
        connectors.cycleError.reset()
        connectors.sessions.newChat()
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

    // ── State plumbing — the single StateFlow fan-in ──────────────────────────────

    private fun emit() {
        _state.value = deriver.derive()
    }

    private fun setStatus(next: SdkStatus) {
        if (deriver.status == next) return
        log.info("status", mapOf("from" to deriver.status, "to" to next))
        deriver.status = next
        if (next == SdkStatus.READY) deriver.connectionLost = false
        emit()
    }

    private fun setError(authExpired: Boolean) {
        deriver.authExpired = authExpired
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
        override fun onAuthFailed() = setError(authExpired = true)
        override fun onConnectionDrop() = this@SentientSdk.onConnectionDrop()
        override fun mergedCapabilities(): List<String> = this@SentientSdk.mergedCapabilities()
        override fun token(): String = bundle.tokenStore.load() ?: ""
        override fun nowMs(): Long = bundle.clock.nowMs()
        override fun isConsumerDisconnected(): Boolean = consumerDisconnected
        override fun status(): SdkStatus = deriver.status
        override fun disconnectForIdle() = disconnect()
    }
}
