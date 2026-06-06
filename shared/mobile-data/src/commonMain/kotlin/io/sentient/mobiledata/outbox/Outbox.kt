package io.sentient.mobiledata.outbox

enum class MessageStatus { QUEUED, SENT, FAILED }

data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
)

class Outbox(private val send: (PendingMessage) -> Unit) {
    private val queue = LinkedHashMap<String, PendingMessage>()

    fun enqueue(msg: PendingMessage) {
        val existing = queue[msg.id]
        if (existing != null && existing.status != MessageStatus.QUEUED) return  // never resurrect a SENT/FAILED id
        queue[msg.id] = msg
    }

    fun onReady() {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) {
                send(m)
                queue[m.id] = m.copy(status = MessageStatus.SENT)
            }
        }
    }

    // reason: surfaced by callers/logging; body marks all still-QUEUED messages terminal.
    fun failAll(@Suppress("UNUSED_PARAMETER") reason: String) {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) queue[m.id] = m.copy(status = MessageStatus.FAILED)
        }
    }

    /** Reset a FAILED message back to QUEUED so the next flush re-sends it. No-op if not FAILED. */
    fun retry(id: String) {
        val m = queue[id] ?: return
        if (m.status == MessageStatus.FAILED) queue[id] = m.copy(status = MessageStatus.QUEUED)
    }

    fun snapshot(): List<PendingMessage> = queue.values.toList()
}
