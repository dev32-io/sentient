// ---------------------------------------------------------------------------
// SdkLifecycle — owns the WS connect attempt, the incoming pump (lifecycle-
// frame interception → router broadcast), the transport-signal → reconnect
// watch, and the idle tick loop. Extracted from SentientSdk so the orchestrator
// stays under the 300-line clean-code budget.
//
// Mirrors web-sdk sentient-sdk.ts connect() + the message-router dispatch +
// the close/reconnect handlers. Holds the mutable transport/session/handshake/
// job refs; SentientSdk owns the public surface + the StateDeriver + status.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.presence.IdleDetector
import io.sentient.mobilesdk.presence.IdleDetectorEvent
import io.sentient.mobilesdk.presence.IdleDetectorState
import io.sentient.mobilesdk.protocol.Capabilities
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.transport.ConnectResult
import io.sentient.mobilesdk.transport.LastErrorKind
import io.sentient.mobilesdk.transport.MessageRouter
import io.sentient.mobilesdk.transport.STALE_RESUME_CHECK_MS
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.transport.SessionResume
import io.sentient.mobilesdk.transport.TransportSignal
import io.sentient.mobilesdk.transport.WS_NORMAL_CLOSURE
import io.sentient.mobilesdk.transport.WebSocketSession
import io.sentient.mobilesdk.transport.WsEvent
import io.sentient.mobilesdk.transport.WsTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val CLIENT_TYPE_MOBILE = "mobile"
private const val FORBIDDEN_CODE = "forbidden"

/** Callbacks the lifecycle drives back into the orchestrator. */
interface LifecycleHooks {
    fun setStatus(next: SdkStatus)
    fun onReady(sessionId: String)
    fun onAuthFailed()
    fun onConnectionDrop()
    fun mergedCapabilities(): List<String>
    fun token(): String
    fun nowMs(): Long
    /** True if the consumer called disconnect() — suppresses reconnect. */
    fun isConsumerDisconnected(): Boolean
    /** Read the live status for the signal/reconnect decision. */
    fun status(): SdkStatus
    /** Disconnect on idle (device disconnect-on-idle policy). */
    fun disconnectForIdle()
}

class SdkLifecycle(
    private val scope: CoroutineScope,
    private val bundleEngine: io.sentient.mobilesdk.transport.WebSocketEngine,
    private val allowSelfSignedDevHost: Boolean,
    private val gatewayWsUrl: String,
    private val router: MessageRouter,
    private val resume: SessionResume,
    private val idle: IdleDetector,
    private val idleTickMs: Long,
    private val delayFn: suspend (Long) -> Unit,
    private val hooks: LifecycleHooks,
    private val log: Log,
    private val handshakeLog: Log,
    /** Called with a typed [SentientError.Protocol] when a control frame fails decode. */
    private val onProtocolError: ((SentientError) -> Unit)? = null,
    /** Debug-only fault hooks; null unless devFaultsEnabled. Threaded into WsTransport + Handshake. */
    private val faultHooks: FaultHooks? = null,
) {
    private var transport: WsTransport? = null
    private var session: WebSocketSession? = null
    private var handshake: Handshake? = null
    private var pumpJob: Job? = null
    private var idleJob: Job? = null

    val activeTransport: WsTransport? get() = transport

    /** Run one connect/auth/session.ready cycle. Never throws — wraps open() failure. */
    suspend fun attemptConnect(): ConnectResult {
        teardown()
        hooks.setStatus(SdkStatus.CONNECTING)
        val url = resume.buildConnectUrl(gatewayWsUrl)
        val open = try {
            bundleEngine.open(url, allowSelfSignedDevHost)
        } catch (e: Exception) {
            log.warn("connect.open-failed", mapOf("error" to (e.message ?: "unknown")))
            return ConnectResult.Failure(LastErrorKind.NETWORK)
        }
        session = open
        val tx = WsTransport(open, scope, onProtocolError, faultHooks)
        transport = tx
        hooks.setStatus(SdkStatus.AUTHENTICATING)
        startSignalWatch(tx)
        val hs = buildHandshake(open)
        handshake = hs
        startPump(tx)
        return when (val result = hs.run()) {
            is HandshakeResult.Ready -> finishReady(result.sessionId)
            is HandshakeResult.Failed -> finishFailed(result.kind)
        }
    }

    private fun finishReady(sessionId: String): ConnectResult {
        resume.setCurrentSessionId(sessionId)
        hooks.onReady(sessionId)
        hooks.setStatus(SdkStatus.READY)
        idle.handle(IdleDetectorEvent.Interaction(hooks.nowMs()))
        startIdleLoop()
        return ConnectResult.Success
    }

    private fun finishFailed(kind: LastErrorKind): ConnectResult {
        if (kind == LastErrorKind.AUTH) hooks.onAuthFailed()
        return ConnectResult.Failure(kind)
    }

    private fun buildHandshake(open: WebSocketSession): Handshake = Handshake(
        session = open,
        sendAuth = { transport?.send(ClientMessage.Auth(token = hooks.token())) },
        faultHooks = faultHooks,
        sendConfigure = {
            transport?.send(
                ClientMessage.SessionConfigure(
                    capabilities = Capabilities(hooks.mergedCapabilities()),
                    clientType = CLIENT_TYPE_MOBILE,
                ),
            )
        },
        onReady = { log.info("session.ready.tunables", mapOf("inRate" to it.inputSampleRate, "outRate" to it.outputSampleRate)) },
        delayFn = delayFn,
        log = handshakeLog,
    )

    // ── Incoming pump: intercept lifecycle → else broadcast to router ──────────

    private fun startPump(tx: WsTransport) {
        pumpJob = scope.launch {
            // ONE in-order consumer: control + audio interleave is preserved by
            // the transport's single event stream, so `connector.audio.done`
            // (control) never overtakes the trailing audio frames it terminates.
            tx.events.collect { event ->
                when (event) {
                    is WsEvent.Control -> onFrame(event.message)
                    is WsEvent.Audio -> router.routeBinary(event.bytes)
                }
            }
        }
    }

    private fun onFrame(msg: ServerMessage) {
        val intercepted = handshake?.intercept(msg) ?: false
        when (msg) {
            // These drive BOTH the resume pointer (here) AND the connectors (broadcast).
            is ServerMessage.SessionSwitched -> resume.setCurrentSessionId(msg.sessionId)
            is ServerMessage.SessionCreated -> resume.setCurrentSessionId(msg.sessionId)
            is ServerMessage.ConversationSnapshot -> armStaleResume()
            is ServerMessage.SessionsError -> if (msg.code == FORBIDDEN_CODE) resume.checkStaleResume()
            else -> Unit
        }
        if (!intercepted) router.route(msg)
    }

    private fun armStaleResume() {
        if (!resume.hasPendingResume()) return
        resume.onSnapshot()
        scope.launch {
            delayFn(STALE_RESUME_CHECK_MS)
            resume.checkStaleResume()
        }
    }

    // ── Transport signals → reconnect ──────────────────────────────────────────

    /**
     * Watch the transport's Closed/Failure signals. Mirrors web-sdk
     * handleSocketClose: a non-clean close on a "live" session (READY) OR mid-
     * handshake (CONNECTING/AUTHENTICATING) — web-sdk's `wasLive` — fails the in-
     * flight handshake FAST (so connect() does not hang the full AUTH/READY
     * timeout) and drives the same recovery path as the READY-drop case. A clean
     * disconnect() (consumer flag) or a normal-closure code never triggers it.
     */
    private fun startSignalWatch(tx: WsTransport) {
        scope.launch {
            tx.signals.collect { signal ->
                if (hooks.isConsumerDisconnected()) return@collect
                if (signal is TransportSignal.Closed && signal.code == WS_NORMAL_CLOSURE) return@collect
                log.warn("transport.signal", mapOf("signal" to signal::class.simpleName, "status" to hooks.status()))
                // Unblock the handshake's withTimeout immediately so a pre-ready
                // close fails fast instead of waiting out AUTH_TIMEOUT_MS/READY_TIMEOUT_MS.
                handshake?.failPending(LastErrorKind.NETWORK)
                if (isLiveOrConnecting(hooks.status())) hooks.onConnectionDrop()
            }
        }
    }

    /** web-sdk `wasLive`: status is not DISCONNECTED and not ERROR. */
    private fun isLiveOrConnecting(status: SdkStatus): Boolean =
        status == SdkStatus.READY ||
            status == SdkStatus.CONNECTING ||
            status == SdkStatus.AUTHENTICATING ||
            status == SdkStatus.RECONNECTING

    // ── Idle loop: tick → disconnect on IDLE ────────────────────────────────────

    private fun startIdleLoop() {
        if (idleJob?.isActive == true) return
        idleJob = scope.launch {
            while (isActive) {
                delayFn(idleTickMs)
                val s = idle.handle(IdleDetectorEvent.Tick(hooks.nowMs()))
                if (s == IdleDetectorState.IDLE) {
                    log.info("idle.disconnect")
                    hooks.disconnectForIdle()
                    return@launch
                }
            }
        }
    }

    /** Tear down the WS + all loops. Idempotent. */
    fun teardown() {
        pumpJob?.cancel(); pumpJob = null
        idleJob?.cancel(); idleJob = null
        val open = session
        if (open != null) {
            scope.launch { open.close(WS_NORMAL_CLOSURE, "User disconnect") }
        }
        transport = null
        session = null
        handshake = null
    }
}
