package io.sentient.mobiledata.outbox

import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.protocol.SdkEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.time.Clock as KtClock
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.getAndUpdate

/**
 * In-memory optimistic-send queue for ONE conversation. Stateful by nature (it IS the
 * cache), so it is owned by the chat VM and dies with the conversation — no reset().
 * [routeGeneration] binds it to that VM's route request; connection-scoped send
 * authority still lives outside this cache.
 *
 * Committed live or REST user receipts remove entries. Scheduling is ATTEMPTED,
 * receipt timeout is UNKNOWN, and an exact command refusal is REJECTED. Neither
 * a timeout nor a refusal proves an earlier attempt was never committed.
 *
 * Send once per connection attempt; authority/voice emissions must not resend.
 * Reconnect clears the attempt guard, preserving pendingId and timeout timestamps.
 *
 * @param clock Injected wall-clock for deterministic testing.
 * @param unackedTimeoutMs Millis after [markSent] before a still-QUEUED entry
 *   is transitioned to FAILED by [sweepTimeouts]. Defaults to
 *   [DEFAULT_UNACKED_TIMEOUT_MS].
 */
class OutboundCache(
    private val clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
    private val unackedTimeoutMs: Long = DEFAULT_UNACKED_TIMEOUT_MS,
) {
    private val queue = LinkedHashMap<String, PendingMessage>()
    private val sentOnConnection = mutableSetOf<String>()
    // Flow upstream (including the Swift bridge) need not run on the VM's actor.
    // Only this mailbox is cross-context; queue mutations remain in flush's caller.
    private val rejections = MutableStateFlow<List<SdkEvent.CommandRejected>>(emptyList())

    internal fun recordRejection(rejection: SdkEvent.CommandRejected) {
        if (rejection.command == "text.input" && rejection.pendingId != null) {
            rejections.update { it + rejection }
        }
    }

    internal fun applyRejections() {
        rejections.getAndUpdate { emptyList() }.forEach { rejection ->
            rejection.pendingId?.let { markRejected(it, rejection.reason) }
        }
    }

    private var sentTransportGeneration: Long? = null

    internal fun unsent(transportGeneration: Long): List<PendingMessage> {
        if (sentTransportGeneration != transportGeneration) {
            sentOnConnection.clear()
            sentTransportGeneration = transportGeneration
        }
        return queued().filter { it.id !in sentOnConnection }
    }

    // Route-instance identity, assigned once by ChatComponent when its owning VM enters.
    // Distinct from sessionId: navigating B -> A -> B must not revive old B VM work.
    internal var routeGeneration: Long? = null
        private set

    internal fun bindToRoute(generation: Long) {
        if (routeGeneration == null) routeGeneration = generation
    }

    internal fun rebindToRoute(generation: Long) {
        routeGeneration = generation
        sentOnConnection.clear()
    }
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    /**
     * Enqueue a new send. No-op if the id already exists in any state — QUEUED
     * (sent or unsent) or FAILED. Prevents duplicate enqueues and resurrection of a
     * failed entry. The gateway dedups by pendingId, so a reconnect re-send of an
     * existing QUEUED entry is handled by [queued] + flush, not by re-enqueuing.
     */
    fun enqueue(id: String, text: String, attachmentIds: List<String> = emptyList()) {
        if (queue[id] != null) return
        queue[id] = PendingMessage(id, text, MessageStatus.QUEUED, attachmentIds = attachmentIds)
        publish()
    }

    /**
     * All QUEUED entries — resendable on reconnect. The gateway dedups by pendingId,
     * so a reconnect re-sending a sent-but-unechoed entry is safe (no double-dispatch).
     */
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == MessageStatus.QUEUED }

    /**
     * Mark a scheduled dispatch attempt, not a proven socket write. Records [sentAtMs] for the
     * unacked-timeout sweep; the entry stays QUEUED for display. The committed echo
     * removes it via [remove].
     */
    fun markSent(id: String) {
        sentOnConnection += id
        transition(id) { it.copy(sentAtMs = clock.nowMs(), deliveryState = PendingDeliveryState.ATTEMPTED) }
    }

    /**
     * Fail a QUEUED entry (disconnect). Any QUEUED entry — sent or unsent — may be
     * failed; the gateway dedups by pendingId so a retry re-send is safe.
     */
    fun markFailed(id: String) = transition(id) {
        if (it.status == MessageStatus.QUEUED) it.copy(
            status = MessageStatus.FAILED,
            deliveryState = if (it.sentAtMs == null) PendingDeliveryState.QUEUED else PendingDeliveryState.UNKNOWN,
        ) else it
    }

    /** Refuse only this scheduled message. Unsent and unrelated rows stay untouched. */
    fun markRejected(id: String, reason: String) = transition(id) {
        if (it.sentAtMs != null) it.copy(
            status = MessageStatus.FAILED,
            deliveryState = PendingDeliveryState.REJECTED,
            rejectionReason = reason,
        ) else it
    }

    /**
     * Re-queue a FAILED entry and clear sentAtMs so the next flush re-sends it.
     * No-op if the entry is not FAILED.
     */
    fun retry(id: String) = transition(id) {
        if (it.status == MessageStatus.FAILED) {
            sentOnConnection -= id
            it.copy(status = MessageStatus.QUEUED, sentAtMs = null, deliveryState = PendingDeliveryState.QUEUED, rejectionReason = null)
        } else it
    }

    /**
     * Sweep for sent-but-unechoed entries that have exceeded [unackedTimeoutMs].
     * Any QUEUED entry with a non-null [sentAtMs] older than the timeout is
     * transitioned to FAILED (shows Retry chip). Publishes once if any change.
     *
     * Call site: the VM drives this on a periodic tick or on connection events.
     */
    fun sweepTimeouts() {
        val now = clock.nowMs()
        var changed = false
        for ((id, msg) in queue.entries.toList()) {
            val sentAt = msg.sentAtMs ?: continue
            if (msg.status == MessageStatus.QUEUED && now - sentAt > unackedTimeoutMs) {
                queue[id] = msg.copy(status = MessageStatus.FAILED, deliveryState = PendingDeliveryState.UNKNOWN)
                changed = true
            }
        }
        if (changed) publish()
    }

    /** Drop a reconciled entry (its committed echo arrived). */
    fun remove(id: String) {
        sentOnConnection -= id
        if (queue.remove(id) != null) publish()
    }

    /** Explicit route deletion only; never use history replacement as proof of receipt. */
    fun dropPending() {
        if (queue.isEmpty()) return
        queue.clear()
        sentOnConnection.clear()
        publish()
    }

    private fun transition(id: String, f: (PendingMessage) -> PendingMessage) {
        val cur = queue[id] ?: return
        queue[id] = f(cur)
        publish()
    }

    private fun publish() {
        _pending.value = queue.values.toList()
    }

    companion object {
        /** Default unacked-send timeout: 10 seconds. */
        const val DEFAULT_UNACKED_TIMEOUT_MS: Long = 10_000L
    }
}

/**
 * Build a default [OutboundCache] (system clock + default unacked timeout).
 *
 * SKIE does NOT synthesise a zero-argument Swift `init()` for a Kotlin constructor
 * whose parameters all have defaults — Swift only sees the full-argument initialiser,
 * which would force the Swift side to construct a [Clock]. This free function gives
 * Swift the same default-constructed cache Android gets from `OutboundCache()`, with
 * no clock plumbing leaking into the UI layer.
 */
fun createOutboundCache(): OutboundCache = OutboundCache()
