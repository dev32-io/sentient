package io.sentient.mobiledata.outbox

/**
 * User-visible outbox status. There is NO "sent" state: a send is dropped on its
 * committed echo (reconcile-by-pendingId in ObserveChatUseCase), never promoted to
 * a "✓ sent" chip. An entry is either still pending ([QUEUED]) or [FAILED] (retryable).
 */
enum class MessageStatus { QUEUED, FAILED }

/**
 * @param flushed INTERNAL re-send guard, NOT a user-visible status. Set true once the
 *   entry has been handed to the transport during the in-flight window (the old SENT
 *   state was previously this guard). A flushed entry stays [QUEUED] for display but is
 *   excluded from the next flush so a reconnect re-fire never double-sends it. The
 *   committed echo drops the entry entirely; a [retry] clears the flag so a FAILED→retry
 *   re-sends.
 */
data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
    val flushed: Boolean = false,
)

class Outbox(private val send: (PendingMessage) -> Unit) {
    private val queue = LinkedHashMap<String, PendingMessage>()

    fun enqueue(msg: PendingMessage) {
        val existing = queue[msg.id]
        if (existing != null && (existing.flushed || existing.status == MessageStatus.FAILED)) return
        queue[msg.id] = msg
    }

    fun onReady() {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED && !m.flushed) {
                send(m)
                queue[m.id] = m.copy(flushed = true) // stays QUEUED; flushed guards re-send
            }
        }
    }

    // reason: surfaced by callers/logging; body marks all still-unflushed QUEUED messages FAILED.
    fun failAll(@Suppress("UNUSED_PARAMETER") reason: String) {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED && !m.flushed) {
                queue[m.id] = m.copy(status = MessageStatus.FAILED)
            }
        }
    }

    /** Reset a FAILED message back to QUEUED (clearing the flush guard) so the next flush re-sends it. No-op if not FAILED. */
    fun retry(id: String) {
        val m = queue[id] ?: return
        if (m.status == MessageStatus.FAILED) queue[id] = m.copy(status = MessageStatus.QUEUED, flushed = false)
    }

    /** Drop every entry. Used to reset the outbox when the conversation switches. */
    fun clear() {
        queue.clear()
    }

    fun snapshot(): List<PendingMessage> = queue.values.toList()
}
