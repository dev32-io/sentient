package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.sdk.ConnectionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.StateFlow

/**
 * Owns the WHEN of the optimistic outbox drain. The cache stays VM-owned and is
 * passed in; this usecase drains only when transport is READY, this cache still owns
 * the current route generation, and that transport has outbound session authority.
 *
 * Session authority gate prevents the "new-chat orphan" race: on a new chat the WS can
 * become READY before the gateway has minted + returned the conversation id via
 * session.created. A flush in that window would dispatch as a fresh chain and the
 * gateway would mint a NEW conversation, orphaning the optimistic bubble. The gate
 * ensures every flush targets an already-known conversation.
 *
 * [authorizedId] is cleared on route intent/transport loss and set only by
 * session.created/draft, matching session.switched, or recovered resume.
 * [authorizedRouteGeneration] changes on every route intent, including B -> A -> B,
 * so retained work from an older VM cannot use a later session authority.
 */
class SendMessageUseCase(
    private val conversation: ConversationRepository,
    private val authorizedId: StateFlow<String?>,
    private val authorizedRouteGeneration: StateFlow<Long?>,
    private val transportGeneration: StateFlow<Long>,
) {
    private val log = createLogger("data", "send-message")

    /** Wake the VM for connection, authority, or queue changes even if READY is unchanged.
     * Cache mutation stays in the collecting VM's scope (MainActor on Swift). */
    fun observeReadiness(cache: OutboundCache, connection: Flow<ConnectionState>): Flow<Unit> =
        combine(connection, authorizedId, authorizedRouteGeneration, transportGeneration, cache.pending) { _, _, _, _, _ -> Unit }

    /** Fire an outbound message immediately. Enqueue/optimism is the VM's OutboundCache. */
    operator fun invoke(text: String, pendingId: String, attachmentIds: List<String> = emptyList()) =
        conversation.send(text, pendingId, attachmentIds)

    /**
     * Drain entries not yet sent on this connection iff READY, route generation
     * matches, and a conversation id is authorized for outbound use.
     * Each entry is sent then marked sent (OutboundCache.markSent records sentAtMs for the unacked-
     * timeout sweep; the entry stays QUEUED for display until its committed echo reconciles
     * it away by pendingId). A non-READY status or missing id is a no-op (entries stay
     * QUEUED for the next rising edge). Re-sending a previously sent-but-unechoed entry
     * on reconnect is safe — the gateway dedups by pendingId.
     */
    fun flushIfReady(cache: OutboundCache, status: SdkStatus) {
        if (status != SdkStatus.READY) {
            log.info("flush-skipped", mapOf("reason" to "not-ready", "status" to status))
            return
        }
        if (cache.routeGeneration == null || cache.routeGeneration != authorizedRouteGeneration.value) {
            log.info("flush-skipped", mapOf("reason" to "stale-route"))
            return
        }
        val sessionId = authorizedId.value
        if (sessionId == null) {
            log.info("flush-skipped", mapOf("reason" to "no-id-attached"))
            return
        }
        val queued = cache.unsent(transportGeneration.value)
        log.info("flush", mapOf("count" to queued.size, "sessionId" to sessionId))
        for (m in queued) {
            conversation.send(m.text, m.id, m.attachmentIds)
            cache.markSent(m.id)
        }
    }
}
