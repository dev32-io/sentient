package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.transport.SdkStatus

/**
 * Owns the WHEN of the optimistic outbox drain. The cache stays VM-owned and is
 * passed in; this usecase decides the flush is allowed only when transport is READY.
 * The session re-establish on reconnect is the SDK's job (Phase A), so this gate is
 * purely on READY.
 */
class SendMessageUseCase(private val conversation: ConversationRepository) {
    private val log = createLogger("data", "send-message")

    /** Fire an outbound message immediately. Enqueue/optimism is the VM's OutboundCache. */
    operator fun invoke(text: String, pendingId: String) = conversation.send(text, pendingId)

    /**
     * Drain still-flushable entries iff transport is ready. Each is sent then marked
     * flushed (an INTERNAL re-send guard — the entry stays QUEUED for display until its
     * committed echo reconciles it away by pendingId). A non-READY status is a no-op (the
     * entries stay QUEUED + unflushed for the next rising edge). A flushed entry is never
     * re-sent (queued() excludes it).
     */
    fun flushIfReady(cache: OutboundCache, status: SdkStatus) {
        if (status != SdkStatus.READY) {
            log.info("flush-skipped", mapOf("reason" to "not-ready", "status" to status))
            return
        }
        val queued = cache.queued()
        log.info("flush", mapOf("count" to queued.size))
        for (m in queued) {
            conversation.send(m.text, m.id)
            cache.markFlushed(m.id)
        }
    }
}
