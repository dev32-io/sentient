package io.sentient.mobiledata.outbox

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory optimistic-send queue for ONE conversation. Stateful by nature (it IS the
 * cache), so it is owned by the chat VM and dies with the conversation — no reset().
 * Knows nothing about the connection; the VM gates the flush on connection-ready.
 *
 * FSM per id: QUEUED → SENT (flushed) | FAILED (disconnect) → QUEUED (retry). A non-QUEUED
 * id is never resurrected by a duplicate enqueue, and never re-sent once SENT.
 */
class OutboundCache {
    private val queue = LinkedHashMap<String, PendingMessage>()
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    fun enqueue(id: String, text: String) {
        val existing = queue[id]
        if (existing != null && existing.status != MessageStatus.QUEUED) return
        queue[id] = PendingMessage(id, text, MessageStatus.QUEUED)
        publish()
    }

    /** All still-QUEUED entries — the VM flushes these on connection-ready. */
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == MessageStatus.QUEUED }

    fun markSent(id: String) = transition(id) { it.copy(status = MessageStatus.SENT) }
    fun markFailed(id: String) = transition(id) {
        if (it.status == MessageStatus.QUEUED) it.copy(status = MessageStatus.FAILED) else it
    }
    fun retry(id: String) = transition(id) {
        if (it.status == MessageStatus.FAILED) it.copy(status = MessageStatus.QUEUED) else it
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
