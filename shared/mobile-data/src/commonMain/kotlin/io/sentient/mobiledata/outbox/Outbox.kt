package io.sentient.mobiledata.outbox

/**
 * User-visible outbox status. There is NO "sent" state: a send is dropped on its
 * committed echo (reconcile-by-pendingId in ObserveChatUseCase), never promoted to
 * a "✓ sent" chip. An entry is either still pending ([QUEUED]) or [FAILED] (retryable).
 */
enum class MessageStatus { QUEUED, FAILED }

/** Transport scheduling/refusal is not a committed receipt. UNKNOWN may already be committed. */
enum class PendingDeliveryState { QUEUED, ATTEMPTED, UNKNOWN, REJECTED }

/**
 * @param sentAtMs Wall-clock ms when dispatch was scheduled (not proof of socket write)
 *   ([OutboundCache.markSent] sets this). Null means no scheduled attempt. Used ONLY for the
 *   unacked-timeout sweep — NOT as a re-send guard. The gateway dedups by
 *   pendingId, so re-sending a sent-but-unechoed entry is safe.
 */
data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
    val sentAtMs: Long? = null,
    val attachmentIds: List<String> = emptyList(),
    val deliveryState: PendingDeliveryState = PendingDeliveryState.QUEUED,
    val rejectionReason: String? = null,
) {
    constructor(id: String, text: String, status: MessageStatus, sentAtMs: Long?) :
        this(id, text, status, sentAtMs, emptyList())
}

