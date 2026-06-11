package io.sentient.mobiledata.outbox

/**
 * User-visible outbox status. There is NO "sent" state: a send is dropped on its
 * committed echo (reconcile-by-pendingId in ObserveChatUseCase), never promoted to
 * a "✓ sent" chip. An entry is either still pending ([QUEUED]) or [FAILED] (retryable).
 */
enum class MessageStatus { QUEUED, FAILED }

/**
 * @param sentAtMs Wall-clock ms when the entry was handed to the transport
 *   ([markSent] sets this). Null means not yet sent. Used ONLY for the
 *   unacked-timeout sweep — NOT as a re-send guard. The gateway dedups by
 *   pendingId, so re-sending a sent-but-unechoed entry is safe.
 */
data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
    val sentAtMs: Long? = null,
)

