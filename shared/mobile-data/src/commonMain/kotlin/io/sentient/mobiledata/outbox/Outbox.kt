package io.sentient.mobiledata.outbox

enum class MessageStatus { QUEUED, SENT, FAILED }

data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
)

class Outbox(private val send: (PendingMessage) -> Unit) {
    private val queue = LinkedHashMap<String, PendingMessage>()

    fun enqueue(msg: PendingMessage) { queue[msg.id] = msg }

    fun onReady() {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) {
                send(m)
                queue[m.id] = m.copy(status = MessageStatus.SENT)
            }
        }
    }

    fun failAll(@Suppress("UNUSED_PARAMETER") reason: String) {
        for (m in queue.values.toList()) {
            if (m.status == MessageStatus.QUEUED) queue[m.id] = m.copy(status = MessageStatus.FAILED)
        }
    }

    fun snapshot(): List<PendingMessage> = queue.values.toList()
}
