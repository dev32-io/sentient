// ---------------------------------------------------------------------------
// SessionsConnector — request/response + broadcast surface for chat-session
// management (list / search / delete / rename / switchTo / newChat).
//
// Mirrors web-sdk's sessions-connector.ts VERBATIM:
//   capability = "sessions"  (status observer + request/response)
//
// TWO correlation patterns (faithfully ported):
//   1. requestId-correlated (list, search, delete, rename):
//        send the frame with a generated requestId; the matching `*.result`
//        frame resolves the suspend call by requestId; `sessions.error` with
//        the same requestId rejects it.
//   2. broadcast-correlated (switchTo, newChat):
//        send the frame; resolve on the NEXT matching broadcast
//        (`session.switched` for switchTo, `session.created` for newChat) —
//        NOT by requestId (the gateway emits these without requestId echo).
//
// Broadcasts (`sessions.deleted`, `session.created`, `session.switched`,
// `sessions.renamed`) also fan out to onSessionsChanged listeners for live UI.
//
// KMP-specific (vs web-sdk):
//   - web-sdk uses Promise + setTimeout + crypto.randomUUID; both are
//     unavailable / non-deterministic in commonMain. We use suspend +
//     CompletableDeferred + withTimeout, and INJECT the id generator
//     (`() -> String`) so tests pass a deterministic counter, and the timeout
//     duration so tests drive it via kotlinx-coroutines-test virtual time.
//   - On timeout the suspend fn throws [SessionsTimeoutException]; on
//     gateway error it throws [SessionsRequestException]. Both are typed,
//     documented exceptions the caller maps — no raw Throwable escapes.
//
// Threading: the orchestrator routes frames on its dispatcher and awaits the
// suspend calls in its scope. The pending map + listeners are owned here.
// detach() does NOT clear listeners (they survive reconnect, matching the TS
// comment) — only pending requests (failed) and inbound bindings reset.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/** Result of [SessionsConnector.list]. Mirrors web-sdk's list result shape. */
data class SessionsListPage(
    val items: List<SessionRow>,
    val total: Int,
    val hasMore: Boolean,
)

/** A session lifecycle change, fanned out to onSessionsChanged listeners. */
sealed class SessionsChangeEvent {
    data class Created(val sessionId: String, val title: String?, val ts: Long) : SessionsChangeEvent()
    data class Switched(val sessionId: String, val title: String?, val ts: Long) : SessionsChangeEvent()
    data class Deleted(val sessionId: String) : SessionsChangeEvent()
    data class Renamed(val sessionId: String, val title: String) : SessionsChangeEvent()
}

/** Thrown when a session request times out waiting for its result frame. */
class SessionsTimeoutException(val frameType: String) :
    Exception("timeout waiting for $frameType")

/** Thrown when the gateway returns a sessions.error for a request. */
class SessionsRequestException(val code: String, override val message: String) :
    Exception("$code: $message")

private const val DEFAULT_TIMEOUT_MS = 5_000L

/** Fallback mint-debounce window when none is injected (matches SdkConfig default). */
private const val DEFAULT_MINT_DEBOUNCE_MS = 3_000L

class SessionsConnector(
    private val send: (ClientMessage) -> Unit,
    private val newId: () -> String,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    private val clock: Clock = Clock { 0L },
    private val mintDebounceMs: Long = DEFAULT_MINT_DEBOUNCE_MS,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "sessions")

    // Wall-clock ms of the last fire-and-forget mint, or null when no mint is in
    // flight. Connection-scoped: cleared on session.created (mint done) and on
    // reset() (disconnect → fresh connection → fresh mint allowed).
    private var lastMintAtMs: Long? = null

    // requestId → deferred result payload. Resolved by the matching *.result
    // frame, failed by sessions.error with the same requestId.
    private val pending = mutableMapOf<String, CompletableDeferred<Any?>>()

    // Broadcast-correlated waiters (switchTo / newChat): resolved by the next
    // matching lifecycle broadcast, not by requestId.
    private val createdWaiters = mutableListOf<CompletableDeferred<String>>()
    private val switchedWaiters = mutableMapOf<String, CompletableDeferred<Unit>>()

    private val listeners = mutableSetOf<(SessionsChangeEvent) -> Unit>()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.SessionsListResult ->
                resolve(msg.requestId, SessionsListPage(msg.items, msg.total, msg.hasMore))
            is ServerMessage.SessionsSearchResult -> resolve(msg.requestId, msg.items)
            is ServerMessage.SessionsDeleteResult -> resolve(msg.requestId, Unit)
            is ServerMessage.SessionsRenameResult -> resolve(msg.requestId, Unit)
            is ServerMessage.SessionsError -> reject(msg.requestId, msg.code, msg.message)
            is ServerMessage.SessionsDeleted -> onDeleted(msg)
            is ServerMessage.SessionsRenamed -> onRenamed(msg)
            is ServerMessage.SessionCreated -> onCreated(msg)
            is ServerMessage.SessionSwitched -> onSwitched(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun resolve(requestId: String, value: Any?) {
        val deferred = pending.remove(requestId) ?: return
        log.info("resolve", mapOf("requestId" to requestId))
        deferred.complete(value)
    }

    private fun reject(requestId: String, code: String, message: String) {
        val deferred = pending.remove(requestId) ?: return
        log.warn("reject", mapOf("requestId" to requestId, "code" to code))
        deferred.completeExceptionally(SessionsRequestException(code, message))
    }

    private fun onDeleted(msg: ServerMessage.SessionsDeleted) {
        dispatch(SessionsChangeEvent.Deleted(msg.sessionId))
    }

    private fun onRenamed(msg: ServerMessage.SessionsRenamed) {
        dispatch(SessionsChangeEvent.Renamed(msg.sessionId, msg.title))
    }

    private fun onCreated(msg: ServerMessage.SessionCreated) {
        // Mint complete → clear the debounce so the next explicit new-chat mints.
        lastMintAtMs = null
        // Resolve any newChat() waiter first (broadcast-correlated), then fan out.
        val waiters = createdWaiters.toList()
        createdWaiters.clear()
        for (w in waiters) w.complete(msg.sessionId)
        dispatch(SessionsChangeEvent.Created(msg.sessionId, msg.title, msg.ts))
    }

    private fun onSwitched(msg: ServerMessage.SessionSwitched) {
        switchedWaiters.remove(msg.sessionId)?.complete(Unit)
        dispatch(SessionsChangeEvent.Switched(msg.sessionId, msg.title, msg.ts))
    }

    private fun dispatch(event: SessionsChangeEvent) {
        for (l in listeners.toList()) l(event)
    }

    // ── requestId-correlated suspend ops ──

    suspend fun list(limit: Int, offset: Int): SessionsListPage {
        val id = newId()
        return await(id, "sessions.list") {
            send(ClientMessage.SessionsList(requestId = id, limit = limit, offset = offset))
        } as SessionsListPage
    }

    @Suppress("UNCHECKED_CAST")
    suspend fun search(q: String, limit: Int = DEFAULT_SEARCH_LIMIT): List<SessionRow> {
        val id = newId()
        return await(id, "sessions.search") {
            send(ClientMessage.SessionsSearch(requestId = id, q = q, limit = limit))
        } as List<SessionRow>
    }

    suspend fun delete(sessionId: String) {
        val id = newId()
        await(id, "sessions.delete") {
            send(ClientMessage.SessionsDelete(requestId = id, sessionId = sessionId))
        }
    }

    suspend fun rename(sessionId: String, title: String) {
        val id = newId()
        await(id, "sessions.rename") {
            send(ClientMessage.SessionsRename(requestId = id, sessionId = sessionId, title = title))
        }
    }

    // ── broadcast-correlated suspend ops ──

    suspend fun switchTo(sessionId: String) {
        val deferred = CompletableDeferred<Unit>()
        switchedWaiters[sessionId] = deferred
        val id = newId()
        log.info("switchTo", mapOf("sessionId" to sessionId, "requestId" to id))
        send(ClientMessage.SessionSwitch(requestId = id, sessionId = sessionId))
        try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            switchedWaiters.remove(sessionId)
            log.warn("timeout", mapOf("frame" to "session.switched", "sessionId" to sessionId))
            throw SessionsTimeoutException("session.switched")
        }
    }

    suspend fun newChat(): String {
        val deferred = CompletableDeferred<String>()
        createdWaiters.add(deferred)
        val id = newId()
        log.info("newChat", mapOf("requestId" to id))
        send(ClientMessage.SessionNew(requestId = id))
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            createdWaiters.remove(deferred)
            log.warn("timeout", mapOf("frame" to "session.created"))
            throw SessionsTimeoutException("session.created")
        }
    }

    // ── fire-and-forget ops (A2) ──
    //
    // Send the frame and return. The gateway broadcasts (session.created /
    // session.switched) still flow back to listeners + the SDK anchor; the caller
    // NEVER awaits, NEVER times out, NEVER throws. The UI must not block on a
    // session round-trip (webui does `void newChat()`).

    /**
     * Fire-and-forget new chat. Debounced: if a mint is still in flight within
     * [mintDebounceMs], log and return so rapid taps collapse to a single ACP mint.
     */
    fun sendNew() {
        val now = clock.nowMs()
        val inFlight = lastMintAtMs
        if (inFlight != null && now - inFlight < mintDebounceMs) {
            log.info("sendNew.debounced", mapOf("sinceMs" to (now - inFlight)))
            return
        }
        lastMintAtMs = now
        val id = newId()
        log.info("sendNew", mapOf("requestId" to id))
        send(ClientMessage.SessionNew(requestId = id))
    }

    /** Fire-and-forget switch. Always sends — no debounce (switch is idempotent). */
    fun sendSwitch(sessionId: String) {
        val id = newId()
        log.info("sendSwitch", mapOf("sessionId" to sessionId, "requestId" to id))
        send(ClientMessage.SessionSwitch(requestId = id, sessionId = sessionId))
    }

    /**
     * Register a sessions-change listener. Returns an unsubscribe fn. Listeners
     * survive detach()/reconnect — only the SDK unregisters them explicitly.
     */
    fun onSessionsChanged(fn: (SessionsChangeEvent) -> Unit): () -> Unit {
        listeners.add(fn)
        return { listeners.remove(fn) }
    }

    /**
     * Fail all in-flight requests and clear inbound state. Does NOT clear
     * listeners — they are user-registered and must survive WS reconnect
     * (mirrors the web-sdk detach() note). Call on disconnect.
     */
    fun reset() {
        log.info("reset", mapOf("pending" to pending.size))
        // Disconnect → new connection → a fresh mint is allowed; clear the debounce.
        lastMintAtMs = null
        val err = SessionsTimeoutException("connector reset")
        for (d in pending.values) d.completeExceptionally(err)
        pending.clear()
        for (d in createdWaiters) d.completeExceptionally(err)
        createdWaiters.clear()
        for (d in switchedWaiters.values) d.completeExceptionally(err)
        switchedWaiters.clear()
    }

    private suspend fun await(requestId: String, frameType: String, sendFrame: () -> Unit): Any? {
        val deferred = CompletableDeferred<Any?>()
        pending[requestId] = deferred
        log.info("request", mapOf("frame" to frameType, "requestId" to requestId))
        sendFrame()
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            pending.remove(requestId)
            log.warn("timeout", mapOf("frame" to frameType, "requestId" to requestId))
            throw SessionsTimeoutException(frameType)
        }
    }

    companion object {
        const val CAPABILITY: String = "sessions"
        private const val DEFAULT_SEARCH_LIMIT = 20
    }
}
