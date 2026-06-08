package io.sentient.mobiledata.repository

import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.Outbox
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * OutboxRepository — owns the optimistic-send queue for ONE conversation.
 *
 * A send is optimistic: [send] enqueues a QUEUED bubble with a client-generated id
 * and returns immediately; the bubble is visible at once via [pending]. Flush is
 * connection-ready-driven:
 * - [setConnected] true flushes all QUEUED messages (marks SENT + invokes [send]).
 * - [send] while already connected flushes immediately.
 * - The gateway echo (committed user entry carrying the same pendingId) is
 *   reconciled away by the combiner in [ChatRepository] via exact id match.
 * - [failOutbox] marks all QUEUED messages FAILED; they stay visible for retry/dismiss.
 *
 * Per-conversation lifecycle: [reset] drops every entry when the conversation
 * switches, so a prior conversation's optimistic/sent bubbles never leak into the
 * next. In-memory only — the queue dies with the session scope; never persistent.
 *
 * @param send  Invoked when flushing a QUEUED message; wired to sdk.sendText(text, pendingId).
 * @param newId Generates a unique pending message id; injected for testability.
 */
class OutboxRepository(
    private val send: (text: String, pendingId: String) -> Unit,
    private val newId: () -> String,
) {
    private val log = createLogger("data", "outbox")
    private val outbox = Outbox(send = { send(it.text, it.id) })
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())

    /** Optimistic pending messages (QUEUED → SENT → FAILED) for the current conversation. */
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    private var connected = false

    /**
     * Enqueues an optimistic QUEUED message and returns its pending id. The bubble
     * is visible immediately in [pending]. If the connection is already READY the
     * message is flushed immediately (SENT + [send] callback); otherwise it waits
     * for [setConnected].
     */
    fun send(text: String): String {
        val id = newId()
        log.info("send.optimistic", mapOf("pendingId" to id, "len" to text.length))
        outbox.enqueue(PendingMessage(id, text))
        _pending.value = outbox.snapshot()
        if (connected) flush()
        return id
    }

    /**
     * Called on every connection-status change. When [isConnected] becomes true,
     * flushes all QUEUED messages — marks them SENT and invokes [send] for each.
     */
    fun setConnected(isConnected: Boolean) {
        connected = isConnected
        if (isConnected) flush()
    }

    /**
     * Re-queues a FAILED message so the next flush re-sends it. No-op if not FAILED.
     * Flushes immediately when the connection is already READY.
     */
    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        outbox.retry(pendingId)
        _pending.value = outbox.snapshot()
        if (connected) flush()
    }

    /** Marks all QUEUED messages FAILED; they remain visible in [pending] for retry/dismiss. */
    fun failOutbox(reason: String) {
        val pendingCount = outbox.snapshot().size
        outbox.failAll(reason)
        _pending.value = outbox.snapshot()
        log.warn("outbox.fail", mapOf("reason" to reason, "pending" to pendingCount))
    }

    /**
     * Drop all pending entries when the conversation switches — a prior conversation's
     * optimistic/sent bubbles must not leak into the next. [connected] is left intact:
     * the socket persists across a conversation switch.
     */
    fun reset() {
        val dropped = outbox.snapshot().size
        outbox.clear()
        _pending.value = emptyList()
        log.info("reset", mapOf("dropped" to dropped))
    }

    private fun flush() {
        val queued = outbox.snapshot().count { it.status == MessageStatus.QUEUED }
        outbox.onReady()
        _pending.value = outbox.snapshot()
        log.info("outbox.flush", mapOf("pending" to queued))
    }
}
