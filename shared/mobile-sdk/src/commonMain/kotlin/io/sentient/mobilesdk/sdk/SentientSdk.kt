// ---------------------------------------------------------------------------
// SentientSdk — THE orchestrator. Wires transport + connectors + handshake +
// reconnect + idle into ONE observable StateFlow<SdkState> (R5).
//
// Mirrors web-sdk sentient-sdk.ts: owns the WS lifecycle (delegated to
// SdkLifecycle), intercepts lifecycle/handshake frames before the MessageRouter
// broadcast, drives the reconnect loop on unexpected close, and disconnects on
// idle. Both native UIs (Phase 2) consume only [state] and re-derive nothing.
//
// Split for the clean-code budget: StateDeriver (the fold), Handshake (the
// auth→ready FSM + frame interception), SdkConnectors (connector wiring),
// SdkLifecycle (WS lifecycle + pump + signal + idle loops). This file owns the
// public surface + the single-StateFlow state plumbing.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.SessionsListPage
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

    private val connectors = SdkConnectors(
        deriver = deriver,
        emit = ::emit,
        send = ::sendControl,
        sendBinary = ::sendBinary,
        newId = newId,
        sessionsTimeoutMs = sessionsTimeoutMs,
    )

    private val router = MessageRouter(connectors.all, audioConnector = connectors.audioOutput)

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
        sendControl(ClientMessage.Interrupt)
    }

    /** P-text: flip voiceMode + send audio.start (full capture pipeline is E3). */
    fun startMic() {
        log.info("startMic", mapOf("captureWired" to (bundle.capture != null)))
        markInteraction()
        deriver.voiceMode = VoiceMode.ACTIVE
        connectors.audioInput.startStreaming()
        emit()
    }

    /** P-text: flip voiceMode + send audio.end. */
    fun stopMic() {
        log.info("stopMic")
        deriver.voiceMode = VoiceMode.OFF
        connectors.audioInput.stopStreaming()
        emit()
    }

    /** Patch TTS on/off; server echoes via session.preferences.changed. */
    suspend fun setTtsEnabled(enabled: Boolean) {
        log.info("setTtsEnabled", mapOf("enabled" to enabled))
        connectors.preferences.patch(AudioPreferencesPatch(ttsEnabled = enabled))
    }

    /** Page the session list (requestId-correlated). */
    suspend fun listSessions(limit: Int, offset: Int): SessionsListPage =
        connectors.sessions.list(limit, offset)

    /** Switch to a session; awaits the session.switched broadcast. */
    suspend fun switchSession(sessionId: String) {
        markInteraction()
        connectors.sessions.switchTo(sessionId)
    }

    /** Start a fresh chat; awaits the session.created broadcast. */
    suspend fun newChat() {
        markInteraction()
        connectors.sessions.newChat()
    }

    suspend fun deleteSession(id: String) = connectors.sessions.delete(id)
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
