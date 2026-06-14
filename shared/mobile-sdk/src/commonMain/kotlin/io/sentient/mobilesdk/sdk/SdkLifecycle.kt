// ---------------------------------------------------------------------------
// SdkLifecycle — owns the WS connect attempt, the incoming pump (lifecycle-
// frame interception → router broadcast), and the transport-signal → reconnect
// watch. Extracted from SentientSdk so the orchestrator stays under the
// 300-line clean-code budget.
//
// Mirrors web-sdk sentient-sdk.ts connect() + the message-router dispatch +
// the close/reconnect handlers. Holds the mutable transport/session/handshake/
// job refs; SentientSdk owns the public surface + the StateDeriver + status.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.protocol.Capabilities
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.transport.ConnectResult
import io.sentient.mobilesdk.transport.LastErrorKind
import io.sentient.mobilesdk.transport.MessageRouter
import io.sentient.mobilesdk.transport.SdkStatus
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
    /** Anchor the active ACP session uuid from a session.switched / session.created frame. */
    fun onSessionAnchored(sessionId: String)
    /** A `sessions.error forbidden` arrived — drop the anchor if a re-establish is in flight. */
    fun onSessionForbidden()
    /** A `pong` arrived — resolve an in-flight foreground liveness probe, if any. */
    fun onPong()
    /** A `stream.resumed` ack arrived (Task 3.10). recovered drives dedup vs. cursor-reset+refetch. */
    fun onStreamResumed(recovered: Boolean)
    /**
     * A cycle reached a natural boundary (completed / aborted). Coalesce point for
     * the durable resume cursor: flush the latest cursor snapshot to the store once
     * per cycle instead of on every applied frame (Task 4.7 save throttling).
     */
    fun onCycleSettled()
    /**
     * Resume params to fold INTO session.configure on a RECONNECT, or null on a
     * first connect / after a non-recovered reset (the cursor has no seq). Read at
     * configure-build time so the gateway sees resume on the single configure frame.
     */
    fun resumeParams(): io.sentient.mobilesdk.protocol.ResumeParams?
    /**
     * The ACP conversation uuid the client is currently displaying, or null when
     * no conversation has been anchored yet. Folded into session.configure so the
     * gateway re-anchors Hermes to the right conversation on a reconnect before
     * the next user.message arrives (Task 3 — conversation continuity).
     */
    fun currentConversationId(): String?
    fun onAuthFailed()
    fun onConnectionDrop()
    fun mergedCapabilities(): List<String>
    fun token(): String
    fun nowMs(): Long
    /** True if the consumer called disconnect() — suppresses reconnect. */
    fun isConsumerDisconnected(): Boolean
    /** Read the live status for the signal/reconnect decision. */
    fun status(): SdkStatus
}

class SdkLifecycle(
    private val scope: CoroutineScope,
    private val bundleEngine: io.sentient.mobilesdk.transport.WebSocketEngine,
    private val allowSelfSignedDevHost: Boolean,
    private val gatewayWsUrl: String,
    /** Stable per-install device id (Task 3.10) — sent in session.configure (REQUIRED by gateway). */
    private val deviceId: String,
    private val router: MessageRouter,
    private val delayFn: suspend (Long) -> Unit,
    private val hooks: LifecycleHooks,
    /** Apply the resume cursor to (seq, epoch); returns false to DROP the frame as a replay dup. */
    private val applyCursor: (seq: Long, epoch: Long?) -> Boolean,
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

    val activeTransport: WsTransport? get() = transport

    /** Run one connect/auth/session.ready cycle. Never throws — wraps open() failure. */
    suspend fun attemptConnect(): ConnectResult {
        teardown()
        hooks.setStatus(SdkStatus.CONNECTING)
        // Connect with the BASE url — no `?session_id=` connect-URL resume (A1).
        // Session continuity is re-established via a fire-and-forget session.switch
        // on reconnect READY (orchestrator), not via the WS-upgrade query param.
        val open = try {
            bundleEngine.open(gatewayWsUrl, allowSelfSignedDevHost)
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
        // Do NOT anchor sessionId here — it is the gateway CONNECTION id (format
        // `s-…`), not the ACP session uuid. Anchoring + replaying it caused the
        // gateway to reject `forbidden "session not owned by current"`. The real
        // ACP uuid is anchored from session.switched / session.created (onFrame).
        hooks.onReady(sessionId)
        hooks.setStatus(SdkStatus.READY)
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
            // Fold the resume request INTO configure on a reconnect (hooks.resumeParams()
            // is null on a first connect / after a non-recovered reset). Single frame →
            // the gateway reads resume synchronously off configure, no separate
            // stream.resume frame, no send-ordering race.
            transport?.send(
                ClientMessage.SessionConfigure(
                    capabilities = Capabilities(hooks.mergedCapabilities()),
                    clientType = CLIENT_TYPE_MOBILE,
                    deviceId = deviceId,
                    surfaceId = deviceId, // 1 app = 1 surface (design §1)
                    resume = hooks.resumeParams(),
                    conversationId = hooks.currentConversationId(),
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
                    is WsEvent.Control -> {
                        // Dedup replayed control frames by seq/epoch before routing.
                        if (applyCursor(event.seq, event.epoch)) onFrame(event.message)
                        else log.debug("frame.dedup-dropped", mapOf("seq" to event.seq, "type" to event.message::class.simpleName))
                    }
                    is WsEvent.Audio -> {
                        // Dedup replayed audio frames by the header seq (peeled by WsTransport).
                        if (applyCursor(event.seq, null)) router.routeBinary(event.bytes)
                        else log.debug("audio.dedup-dropped", mapOf("seq" to event.seq, "bytes" to event.bytes.size))
                    }
                }
            }
        }
    }

    private fun onFrame(msg: ServerMessage) {
        val intercepted = handshake?.intercept(msg) ?: false
        when (msg) {
            // Anchor the active ACP session uuid AND fan out to the connectors
            // (broadcast). The orchestrator ignores empty ids defensively.
            is ServerMessage.SessionSwitched -> hooks.onSessionAnchored(msg.sessionId)
            is ServerMessage.SessionCreated -> hooks.onSessionAnchored(msg.sessionId)
            // A forbidden mid re-establish means the anchored session was revoked
            // elsewhere — the orchestrator drops the anchor so reconnects stop
            // re-firing a switch to a dead session.
            is ServerMessage.SessionsError -> if (msg.code == FORBIDDEN_CODE) hooks.onSessionForbidden()
            // Pong resolves an in-flight foreground liveness probe (proves the socket
            // survived a backgrounding); harmless if no probe is pending.
            is ServerMessage.Pong -> hooks.onPong()
            // Resume ack (Task 3.10): recovered=true → dedup handles replays;
            // recovered=false → orchestrator resets cursor + refetches history.
            is ServerMessage.StreamResumed -> hooks.onStreamResumed(msg.recovered)
            // Cycle boundary → coalesce the durable resume-cursor write (Task 4.7).
            is ServerMessage.CycleCompleted -> hooks.onCycleSettled()
            is ServerMessage.CycleAborted -> hooks.onCycleSettled()
            else -> Unit
        }
        if (!intercepted) router.route(msg)
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

    /** Tear down the WS + all loops. Idempotent. */
    fun teardown() {
        pumpJob?.cancel(); pumpJob = null
        val open = session
        if (open != null) {
            scope.launch { open.close(WS_NORMAL_CLOSURE, "User disconnect") }
        }
        transport = null
        session = null
        handshake = null
    }
}
