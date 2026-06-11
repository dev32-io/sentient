package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.StateFlow

/**
 * Owns the WHEN of the optimistic outbox drain. The cache stays VM-owned and is
 * passed in; this usecase decides the flush is allowed only when BOTH transport is READY
 * AND a conversation id is attached ([attachedId] is non-null).
 *
 * The two-part gate prevents the "new-chat orphan" race: on a new chat the WS can
 * become READY before the gateway has minted + returned the conversation id via
 * session.created. A flush in that window would dispatch as a fresh chain and the
 * gateway would mint a NEW conversation, orphaning the optimistic bubble. The gate
 * ensures every flush targets an already-known conversation.
 *
 * [attachedId] is the component's [currentSessionId] StateFlow (set from
 * session.created on a new chat, or session.switched on activate). The VM-facing
 * [flushIfReady] signature is unchanged; the gate is applied internally.
 */
class SendMessageUseCase(
    private val conversation: ConversationRepository,
    private val attachedId: StateFlow<String?>,
) {
    private val log = createLogger("data", "send-message")

    /** Fire an outbound message immediately. Enqueue/optimism is the VM's OutboundCache. */
    operator fun invoke(text: String, pendingId: String) = conversation.send(text, pendingId)

    /**
     * Drain still-flushable entries iff transport is READY AND a conversation id is
     * attached. Each entry is sent then marked flushed (an INTERNAL re-send guard — the
     * entry stays QUEUED for display until its committed echo reconciles it away by
     * pendingId). A non-READY status or missing id is a no-op (entries stay QUEUED +
     * unflushed for the next rising edge). A flushed entry is never re-sent
     * (queued() excludes it).
     */
    fun flushIfReady(cache: OutboundCache, status: SdkStatus) {
        if (status != SdkStatus.READY) {
            log.info("flush-skipped", mapOf("reason" to "not-ready", "status" to status))
            return
        }
        val sessionId = attachedId.value
        if (sessionId == null) {
            log.info("flush-skipped", mapOf("reason" to "no-id-attached"))
            return
        }
        val queued = cache.queued()
        log.info("flush", mapOf("count" to queued.size, "sessionId" to sessionId))
        for (m in queued) {
            conversation.send(m.text, m.id)
            cache.markFlushed(m.id)
        }
    }
}
