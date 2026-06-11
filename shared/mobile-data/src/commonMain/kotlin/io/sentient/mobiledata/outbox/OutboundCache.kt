package io.sentient.mobiledata.outbox

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory optimistic-send queue for ONE conversation. Stateful by nature (it IS the
 * cache), so it is owned by the chat VM and dies with the conversation — no reset().
 * Knows nothing about the connection; the VM gates the flush on connection-ready.
 *
 * There is NO "sent" state. An entry is QUEUED until its committed echo arrives, at
 * which point the VM [remove]s it (reconcile-by-pendingId, driven by the LIVE echo —
 * NOT the pendingId-stripping DB mirror). The only terminal-visible state is FAILED
 * (disconnect), which a [retry] re-queues.
 *
 * FSM per id: QUEUED → (flushed guard set on drain, still QUEUED) → removed on echo,
 * OR QUEUED → FAILED (disconnect) → QUEUED (retry). A flushed or FAILED id is never
 * resurrected by a duplicate enqueue, and a flushed entry is never re-sent.
 */
class OutboundCache {
    private val queue = LinkedHashMap<String, PendingMessage>()
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    fun enqueue(id: String, text: String) {
        val existing = queue[id]
        if (existing != null && (existing.flushed || existing.status == MessageStatus.FAILED)) return
        queue[id] = PendingMessage(id, text, MessageStatus.QUEUED)
        publish()
    }

    /**
     * Still-flushable entries — QUEUED and NOT yet flushed. The VM drains these on
     * connection-ready; the [flushed] guard keeps a reconnect re-fire from re-sending an
     * entry that is still awaiting its echo.
     */
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == MessageStatus.QUEUED && !it.flushed }

    /** Mark an entry flushed (handed to the transport). Stays QUEUED for display; the echo removes it. */
    fun markFlushed(id: String) = transition(id) { it.copy(flushed = true) }
    fun markFailed(id: String) = transition(id) {
        if (it.status == MessageStatus.QUEUED && !it.flushed) it.copy(status = MessageStatus.FAILED) else it
    }
    fun retry(id: String) = transition(id) {
        if (it.status == MessageStatus.FAILED) it.copy(status = MessageStatus.QUEUED, flushed = false) else it
    }

    /** Drop a reconciled entry (its committed echo arrived). */
    fun remove(id: String) {
        if (queue.remove(id) != null) publish()
    }

    private fun transition(id: String, f: (PendingMessage) -> PendingMessage) {
        val cur = queue[id] ?: return
        queue[id] = f(cur)
        publish()
    }

    private fun publish() {
        _pending.value = queue.values.toList()
    }
}
