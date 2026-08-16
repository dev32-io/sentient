// ---------------------------------------------------------------------------
// SessionsConnector — session lifecycle surface for the SDK.
//
// Mirrors web-sdk's sessions-connector.ts post-Task-2.5 shape:
//   capability = "sessions"  (status observer + lifecycle frames)
//
// Query/mutation operations (list/search/delete/rename) are now REST
// (SessionsHttpClient) — the WS query RPCs were removed in protocol Task 2.1.
// Only session-lifecycle WS frames remain here.
//
// LIFECYCLE frame patterns:
//   switchTo / sendSwitch — send conversation.activate; resolve on session.switched
//   newChat / sendNew    — send session.new; resolve on session.created broadcast
//
// Broadcasts (session.created, session.switched, sessions.deleted, sessions.renamed)
// still fan out to onSessionsChanged listeners for live UI.
//
// REST ops (list/search/delete/rename) delegate to the injected
// [SessionsHttpClient] and complete inline — no requestId correlation needed.
//
// KMP-specific:
//   - timeout uses suspend + withTimeout + virtual time for tests.
//   - On timeout the suspend fn throws [SessionsTimeoutException].
//
// Threading: the orchestrator routes frames on its dispatcher; the pending maps +
// listeners are owned here. detach() does NOT clear listeners — they survive
// reconnect. reset() fails pending requests on disconnect.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.sessions.SessionsHttpClient
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

    /** No session yet — [draftKey] is the handle this client holds until its
     *  first message mints one. A draft has no row and must never be listed. */
    data class Draft(val draftKey: String, val ts: Long) : SessionsChangeEvent()
    data class Deleted(val sessionId: String) : SessionsChangeEvent()
    data class Renamed(val sessionId: String, val title: String) : SessionsChangeEvent()
}

/** Thrown when a session lifecycle request times out. */
class SessionsTimeoutException(val frameType: String) :
    Exception("timeout waiting for $frameType")

/** Thrown when the gateway returns a sessions.error for a lifecycle request. */
class SessionsRequestException(val code: String, override val message: String) :
    Exception("$code: $message")

private const val DEFAULT_TIMEOUT_MS = 5_000L
private const val DEFAULT_MINT_DEBOUNCE_MS = 3_000L

class SessionsConnector(
    private val send: (ClientMessage) -> Unit,
    private val newId: () -> String,
    private val clock: Clock,
    private val httpClient: SessionsHttpClient? = null,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    private val mintDebounceMs: Long = DEFAULT_MINT_DEBOUNCE_MS,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "sessions")

    // Connection-scoped debounce. An explicit preparation is retained across a
    // transport edge so a pre-READY request can be retried exactly once.
    private var lastMintAtMs: Long? = null
    private var pendingMintIntent: String? = null

    // Broadcast-correlated waiters (switchTo / newChat).
    private val createdWaiters = mutableListOf<CompletableDeferred<String>>()
    private val switchedWaiters = mutableMapOf<String, CompletableDeferred<Unit>>()

    private val listeners = mutableSetOf<(SessionsChangeEvent) -> Unit>()

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.SessionsError -> onSessionsError(msg)
            is ServerMessage.SessionsDeleted -> dispatch(SessionsChangeEvent.Deleted(msg.sessionId))
            is ServerMessage.SessionsRenamed -> dispatch(SessionsChangeEvent.Renamed(msg.sessionId, msg.title))
            is ServerMessage.SessionCreated -> onCreated(msg)
            is ServerMessage.SessionSwitched -> onSwitched(msg)
            is ServerMessage.SessionDraft -> onDraft(msg)
            // The gateway's own titling push. Fanned out as Renamed because
            // every consumer does the same thing with it — put this title on
            // this row — and the guard that decides whether a generated title
            // may land at all is enforced in the gateway's store, not here.
            is ServerMessage.SessionTitle -> dispatch(SessionsChangeEvent.Renamed(msg.sessionId, msg.title))
            else -> Unit // not owned by this connector
        }
    }

    private fun onSessionsError(msg: ServerMessage.SessionsError) {
        // Only the switched-waiter path can receive a sessions.error now; reject it.
        // requestId is nullable — conversation.activate errors have none; in that case
        // no waiter exists (fire-and-forget) so the remove is a safe no-op.
        val waiter = switchedWaiters.remove(msg.requestId)
        if (waiter != null) {
            log.warn("switch.error", mapOf("requestId" to msg.requestId, "code" to msg.code))
            waiter.completeExceptionally(SessionsRequestException(msg.code, msg.message))
        }
    }

    private fun onCreated(msg: ServerMessage.SessionCreated) {
        lastMintAtMs = null
        pendingMintIntent = null
        val waiters = createdWaiters.toList()
        createdWaiters.clear()
        for (w in waiters) w.complete(msg.sessionId)
        dispatch(SessionsChangeEvent.Created(msg.sessionId, msg.title, msg.ts))
    }

    /**
     * A draft answers a pending mint exactly as a created session does: the
     * "+" tap is complete, and the key is what the client anchors on so its
     * outbound queue drains. Clearing [lastMintAtMs] here matters — the
     * debounce must not stay armed against a mint that was already answered.
     */
    private fun onDraft(msg: ServerMessage.SessionDraft) {
        lastMintAtMs = null
        pendingMintIntent = null
        val waiters = createdWaiters.toList()
        createdWaiters.clear()
        for (w in waiters) w.complete(msg.draftKey)
        dispatch(SessionsChangeEvent.Draft(msg.draftKey, msg.ts))
    }

    private fun onSwitched(msg: ServerMessage.SessionSwitched) {
        switchedWaiters.remove(msg.sessionId)?.complete(Unit)
        dispatch(SessionsChangeEvent.Switched(msg.sessionId, msg.title, msg.ts))
    }

    private fun dispatch(event: SessionsChangeEvent) {
        for (l in listeners.toList()) l(event)
    }

    // ── REST-backed query ops ──────────────────────────────────────────────────

    /** Page the session list via REST GET /api/v1/sessions. */
    suspend fun list(limit: Int, offset: Int): SessionsListPage {
        log.debug("list", mapOf("limit" to limit, "offset" to offset))
        val items = httpClient?.list(limit, offset) ?: emptyList()
        return SessionsListPage(items = items, total = items.size, hasMore = false)
    }

    /** Search sessions via REST GET /api/v1/sessions/search. */
    suspend fun search(q: String, limit: Int = DEFAULT_SEARCH_LIMIT): List<SessionRow> {
        log.debug("search", mapOf("qLen" to q.length))
        return httpClient?.search(q, limit) ?: emptyList()
    }

    /**
     * Delete a session via REST DELETE /api/v1/sessions/:id.
     * Fans out [SessionsChangeEvent.Deleted] only when the REST call returns true (2xx).
     * On failure, logs a warn and does not fan out — the next list refresh shows reality.
     */
    suspend fun delete(sessionId: String) {
        log.debug("delete", mapOf("sessionId" to sessionId))
        val ok = httpClient?.delete(sessionId) ?: true
        if (ok) {
            dispatch(SessionsChangeEvent.Deleted(sessionId))
        } else {
            log.warn("delete.no-fanout", mapOf("sessionId" to sessionId, "reason" to "REST call failed"))
        }
    }

    /**
     * Rename a session via REST PATCH /api/v1/sessions/:id.
     * Fans out [SessionsChangeEvent.Renamed] only when the REST call returns true (2xx).
     * On failure, logs a warn and does not fan out — the next list refresh shows reality.
     */
    suspend fun rename(sessionId: String, title: String) {
        log.debug("rename", mapOf("sessionId" to sessionId))
        val ok = httpClient?.rename(sessionId, title) ?: true
        if (ok) {
            dispatch(SessionsChangeEvent.Renamed(sessionId, title))
        } else {
            log.warn("rename.no-fanout", mapOf("sessionId" to sessionId, "reason" to "REST call failed"))
        }
    }

    // ── WS lifecycle ops ──────────────────────────────────────────────────────

    /** Send conversation.activate and await the session.switched broadcast. */
    suspend fun switchTo(sessionId: String) {
        val deferred = CompletableDeferred<Unit>()
        switchedWaiters[sessionId] = deferred
        val id = newId()
        log.info("switchTo", mapOf("sessionId" to sessionId, "requestId" to id))
        send(ClientMessage.ConversationActivate(sessionId = sessionId))
        try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            switchedWaiters.remove(sessionId)
            log.warn("timeout", mapOf("frame" to "session.switched", "sessionId" to sessionId))
            throw SessionsTimeoutException("session.switched")
        }
    }

    /**
     * Send an EXPLICIT session.new and await the answer — the id on
     * `session.created` when the connection was bound, or the draft key on
     * `session.draft` when the gateway unbound it and there is nothing minted
     * yet.
     */
    suspend fun newChat(): String {
        val deferred = CompletableDeferred<String>()
        createdWaiters.add(deferred)
        val id = newId()
        log.info("newChat", mapOf("requestId" to id))
        send(ClientMessage.SessionNew(requestId = id, intent = INTENT_EXPLICIT))
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            createdWaiters.remove(deferred)
            log.warn("timeout", mapOf("frame" to "session.created"))
            throw SessionsTimeoutException("session.created")
        }
    }

    // ── fire-and-forget ops (A2) ──────────────────────────────────────────────

    /** Legacy compatibility operation. Its omitted intent preserves gateway
     * reattachment semantics for non-mobile callers. */
    fun sendNew() = sendNewWithIntent(null)

    /** Prepare an intentionally fresh boundary without blocking the composer. */
    fun startFreshChat() = sendNewWithIntent(INTENT_EXPLICIT)

    private fun sendNewWithIntent(intent: String?) {
        val now = clock.nowMs()
        val inFlight = lastMintAtMs
        if (inFlight != null && now - inFlight < mintDebounceMs) {
            log.info("sendNew.debounced", mapOf("sinceMs" to (now - inFlight)))
            return
        }
        lastMintAtMs = now
        pendingMintIntent = intent
        val id = newId()
        log.info("sendNew", mapOf("requestId" to id, "explicit" to (intent == INTENT_EXPLICIT)))
        send(ClientMessage.SessionNew(requestId = id, intent = intent))
    }

    /**
     * True when a sendNew was attempted but session.created has not yet confirmed it.
     * Used by the SDK to detect a dropped pre-READY mint and re-fire on the READY
     * rising edge (the transport was not open when the original sendNew fired).
     * SDK-internal — not part of the public connector surface.
     */
    internal fun hasPendingMint(): Boolean = lastMintAtMs != null

    /**
     * Clear the mint debounce clock and re-send a session.new. Used exclusively by
     * the SDK on the first-connect READY rising edge when [hasPendingMint] is true:
     * the original sendNew was dropped (null transport), so we retry unconditionally.
     * SDK-internal — not part of the public connector surface.
     */
    internal fun retryPendingMint() {
        val intent = pendingMintIntent
        lastMintAtMs = null
        sendNewWithIntent(intent)
    }

    /** Fire-and-forget switch via conversation.activate. Always sends — no debounce. */
    fun sendSwitch(sessionId: String) {
        log.info("sendSwitch", mapOf("sessionId" to sessionId))
        send(ClientMessage.ConversationActivate(sessionId = sessionId))
    }

    /**
     * Register a sessions-change listener. Returns an unsubscribe fn.
     * Listeners survive detach()/reconnect.
     */
    fun onSessionsChanged(fn: (SessionsChangeEvent) -> Unit): () -> Unit {
        listeners.add(fn)
        return { listeners.remove(fn) }
    }

    /**
     * Fail all in-flight lifecycle requests and clear connection-scoped state.
     * Does NOT clear listeners — they survive WS reconnect.
     * Call on disconnect.
     */
    fun reset() {
        log.info("reset", mapOf("switched" to switchedWaiters.size, "created" to createdWaiters.size))
        // Keep an explicit preparation armed across a transport edge. Implicit
        // compatibility mints remain connection-scoped and are dropped as before.
        if (pendingMintIntent != INTENT_EXPLICIT) {
            lastMintAtMs = null
            pendingMintIntent = null
        }
        val err = SessionsTimeoutException("connector reset")
        for (d in createdWaiters) d.completeExceptionally(err)
        createdWaiters.clear()
        for (d in switchedWaiters.values) d.completeExceptionally(err)
        switchedWaiters.clear()
    }

    companion object {
        const val CAPABILITY: String = "sessions"
        private const val DEFAULT_SEARCH_LIMIT = 20

        /** `session.new.intent` — a person pressing "+", as opposed to the app
         *  launching with no route id (the gateway's default, "implicit"). */
        private const val INTENT_EXPLICIT = "explicit"
    }
}
