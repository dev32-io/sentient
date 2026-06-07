// ---------------------------------------------------------------------------
// Handshake — the connect/auth/session.ready FSM + lifecycle-frame routing.
//
// Mirrors web-sdk sentient-sdk.ts connect() + sdk-message-router routeByType:
//   1. DISCONNECTED → CONNECTING: open WS (SessionResume URL appends ?session_id).
//   2. CONNECTING → AUTHENTICATING: send ClientMessage.Auth(token); arm auth timeout.
//   3. auth.ok → send ClientMessage.SessionConfigure(clientType="mobile",
//      capabilities = config ∪ every connector capability); arm ready timeout.
//   4. session.ready → READY; SessionResume.setCurrentSessionId(sessionId).
//   On AUTH_TIMEOUT_MS / READY_TIMEOUT_MS → close WS with the client-sent
//   WS_AUTH_TIMEOUT_CODE / WS_READY_TIMEOUT_CODE and fail the attempt.
//   auth.error → terminal AUTH failure (token won't recover via retry).
//
// LIFECYCLE-FRAME INTERCEPTION (mirror routeByType): the orchestrator hands
// every decoded frame to [intercept] FIRST. If it returns true the frame was a
// lifecycle/handshake frame and is consumed here — NOT broadcast to connectors.
// Everything else falls through to MessageRouter.route(). session.switched is
// the one frame that is BOTH intercepted (resume pointer) AND broadcast
// (connectors mirror it) — see the orchestrator's onFrame.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.dev.FaultHooks
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.transport.AUTH_TIMEOUT_MS
import io.sentient.mobilesdk.transport.LastErrorKind
import io.sentient.mobilesdk.transport.READY_TIMEOUT_MS
import io.sentient.mobilesdk.transport.WS_AUTH_TIMEOUT_CODE
import io.sentient.mobilesdk.transport.WS_READY_TIMEOUT_CODE
import io.sentient.mobilesdk.transport.WebSocketSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/** Outcome of the [Handshake.run] auth/ready gate, distinct from the wire result. */
sealed class HandshakeResult {
    /** Reached session.ready with the negotiated [sessionId]. */
    data class Ready(val sessionId: String) : HandshakeResult()

    /** Failed before ready with the given error [kind]. */
    data class Failed(val kind: LastErrorKind) : HandshakeResult()
}

/**
 * Drives the auth→ready gate for one connect attempt and intercepts lifecycle
 * frames. Single-use per attempt; the orchestrator constructs a fresh one each
 * connect. Time is injected via [delayFn] so tests use virtual time.
 *
 * @param send Send a [ClientMessage] over the active transport.
 * @param session The open WS session — closed on timeout with the client codes.
 * @param sendAuth Emit the auth frame (token resolved by the orchestrator).
 * @param sendConfigure Emit session.configure (capabilities + clientType="mobile").
 * @param onReady Called with the session.ready frame so the orchestrator persists
 *   the resume pointer + folds tunables before flipping status to READY.
 * @param delayFn Suspending sleep for the auth/ready timeout race.
 * @param log Integration-trail logger.
 */
class Handshake(
    private val session: WebSocketSession,
    private val sendAuth: suspend () -> Unit,
    private val sendConfigure: suspend () -> Unit,
    private val onReady: (ServerMessage.SessionReady) -> Unit,
    private val delayFn: suspend (Long) -> Unit,
    private val log: Log,
    /** Debug-only fault hooks; null unless devFaultsEnabled. Consulted on auth.ok. */
    private val faultHooks: FaultHooks? = null,
) {
    private val authGate = CompletableDeferred<Unit>()
    private val readyGate = CompletableDeferred<ServerMessage.SessionReady>()
    private var failed: LastErrorKind? = null

    /**
     * Intercept a lifecycle/handshake frame. Returns true if the frame was
     * consumed here (do NOT broadcast to connectors). auth.ok/auth.error/
     * session.ready/session.expired are intercepted; everything else falls
     * through (returns false). Mirrors routeByType.
     */
    fun intercept(msg: ServerMessage): Boolean = when (msg) {
        is ServerMessage.AuthOk -> {
            log.info("auth.ok", mapOf("userId" to msg.user.userId))
            // DEBUG fault: if expired-token is armed, simulate an auth failure instead of
            // completing the auth gate. Arm via:
            //   adb shell am broadcast -a io.sentient.debug.FAULT --es kind expired
            if (faultHooks?.consumeExpiredToken() == true) {
                log.warn("fault.expired-token", mapOf("reason" to "injected by FaultHooks"))
                failGates(LastErrorKind.AUTH)
            } else {
                authGate.complete(Unit)
            }
            true
        }
        is ServerMessage.AuthError -> {
            log.warn("auth.error", mapOf("code" to msg.code))
            failGates(LastErrorKind.AUTH)
            true
        }
        is ServerMessage.SessionReady -> {
            log.info("session.ready", mapOf("sessionId" to msg.sessionId))
            if (!readyGate.isCompleted) readyGate.complete(msg)
            true
        }
        is ServerMessage.SessionExpired -> {
            log.warn("session.expired", mapOf("reason" to msg.reason))
            failGates(LastErrorKind.AUTH)
            true
        }
        else -> false
    }

    /**
     * Run the auth→ready gate. Sends auth, awaits auth.ok (auth timeout), sends
     * session.configure, awaits session.ready (ready timeout). On timeout closes
     * the socket with the client-sent code and returns Failed(TIMEOUT). On
     * auth.error/session.expired returns Failed(AUTH).
     */
    suspend fun run(): HandshakeResult {
        log.info("auth.send")
        sendAuth()
        if (!awaitGate(authGate, AUTH_TIMEOUT_MS, WS_AUTH_TIMEOUT_CODE, "Auth timeout")) {
            return HandshakeResult.Failed(failed ?: LastErrorKind.TIMEOUT)
        }
        log.info("session.configure.send")
        sendConfigure()
        val ready = awaitReady()
            ?: return HandshakeResult.Failed(failed ?: LastErrorKind.TIMEOUT)
        onReady(ready)
        return HandshakeResult.Ready(ready.sessionId)
    }

    /**
     * Fail any still-pending gate with the given [kind] so the in-flight
     * [run] returns FAST instead of burning the full AUTH/READY timeout. Called
     * by SdkLifecycle when a non-clean transport Closed/Failure arrives mid-
     * handshake (mirrors web-sdk's onclose firing the connect Promise's `fail`
     * before session.ready). No-op once both gates have settled.
     */
    fun failPending(kind: LastErrorKind) {
        if (authGate.isCompleted && readyGate.isCompleted) return
        log.warn("handshake.transport-closed", mapOf("kind" to kind))
        failGates(kind)
    }

    private fun failGates(kind: LastErrorKind) {
        failed = kind
        if (!authGate.isCompleted) authGate.completeExceptionally(GateFailed)
        if (!readyGate.isCompleted) readyGate.completeExceptionally(GateFailed)
    }

    private suspend fun awaitGate(gate: CompletableDeferred<Unit>, timeoutMs: Long, code: Int, reason: String): Boolean =
        raceTimeout(timeoutMs, code, reason) { gate.await() }

    private suspend fun awaitReady(): ServerMessage.SessionReady? {
        var result: ServerMessage.SessionReady? = null
        val ok = raceTimeout(READY_TIMEOUT_MS, WS_READY_TIMEOUT_CODE, "Session ready timeout") {
            result = readyGate.await()
        }
        return if (ok) result else null
    }

    private suspend fun raceTimeout(timeoutMs: Long, code: Int, reason: String, await: suspend () -> Unit): Boolean =
        try {
            withTimeout(timeoutMs) { await() }
            failed == null
        } catch (e: TimeoutCancellationException) {
            log.warn("handshake.timeout", mapOf("code" to code, "reason" to reason))
            failed = LastErrorKind.TIMEOUT
            session.close(code, reason)
            false
        } catch (e: GateFailedException) {
            false // failGates already recorded the kind
        }

    private companion object {
        /** Sentinel used to fail the gates on auth.error / session.expired. */
        val GateFailed = GateFailedException()
    }
}

/** Internal sentinel exception to unblock awaiting gates on auth failure. */
class GateFailedException : Exception("handshake gate failed")
