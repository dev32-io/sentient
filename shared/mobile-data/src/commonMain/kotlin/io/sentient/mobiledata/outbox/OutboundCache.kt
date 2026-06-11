package io.sentient.mobiledata.outbox

import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlin.time.Clock as KtClock
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory optimistic-send queue for ONE conversation. Stateful by nature (it IS the
 * cache), so it is owned by the chat VM and dies with the conversation — no reset().
 * Knows nothing about the connection; the VM gates the flush on connection-ready.
 *
 * There is NO "sent" state. An entry is QUEUED until its committed echo arrives, at
 * which point the VM [remove]s it (reconcile-by-pendingId, driven by the LIVE echo —
 * NOT the pendingId-stripping DB mirror). The only terminal-visible state is FAILED
 * (disconnect or unacked-timeout), which a [retry] re-queues.
 *
 * FSM per id:
 *   QUEUED → (markSent: sentAtMs set, still QUEUED) → removed on echo
 *          | FAILED (disconnect OR unacked-timeout via sweepTimeouts) → retry → QUEUED
 *
 * NO resend guard: the gateway dedups by pendingId, so a reconnect re-sending a
 * sent-but-unechoed entry is safe. sentAtMs tracks when the entry was handed to the
 * transport for the timeout sweep ONLY — it does NOT gate re-sends.
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
    private val _pending = MutableStateFlow<List<PendingMessage>>(emptyList())
    val pending: StateFlow<List<PendingMessage>> = _pending.asStateFlow()

    /**
     * Enqueue a new send. No-op if the id already exists in any state — QUEUED
     * (sent or unsent) or FAILED. Prevents duplicate enqueues and resurrection of a
     * failed entry. The gateway dedups by pendingId, so a reconnect re-send of an
     * existing QUEUED entry is handled by [queued] + flush, not by re-enqueuing.
     */
    fun enqueue(id: String, text: String) {
        if (queue[id] != null) return
        queue[id] = PendingMessage(id, text, MessageStatus.QUEUED)
        publish()
    }

    /**
     * All QUEUED entries — resendable on reconnect. The gateway dedups by pendingId,
     * so a reconnect re-sending a sent-but-unechoed entry is safe (no double-dispatch).
     */
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == MessageStatus.QUEUED }

    /**
     * Mark an entry as sent (handed to the transport). Records [sentAtMs] for the
     * unacked-timeout sweep; the entry stays QUEUED for display. The committed echo
     * removes it via [remove].
     */
    fun markSent(id: String) = transition(id) { it.copy(sentAtMs = clock.nowMs()) }

    /**
     * Fail a QUEUED entry (disconnect). Any QUEUED entry — sent or unsent — may be
     * failed; the gateway dedups by pendingId so a retry re-send is safe.
     */
    fun markFailed(id: String) = transition(id) {
        if (it.status == MessageStatus.QUEUED) it.copy(status = MessageStatus.FAILED) else it
    }

    /**
     * Re-queue a FAILED entry and clear sentAtMs so the next flush re-sends it.
     * No-op if the entry is not FAILED.
     */
    fun retry(id: String) = transition(id) {
        if (it.status == MessageStatus.FAILED) it.copy(status = MessageStatus.QUEUED, sentAtMs = null) else it
    }

    /**
     * Sweep for sent-but-unechoed entries that have exceeded [unackedTimeoutMs].
     * Any QUEUED entry with a non-null [sentAtMs] older than the timeout is
     * transitioned to FAILED (shows Retry chip). Publishes once if any change.
     *
     * Call site: the VM should drive this on a periodic tick or on connection events.
     * Phase 4 wiring responsibility.
     */
    fun sweepTimeouts() {
        val now = clock.nowMs()
        var changed = false
        for ((id, msg) in queue.entries.toList()) {
            val sentAt = msg.sentAtMs ?: continue
            if (msg.status == MessageStatus.QUEUED && now - sentAt > unackedTimeoutMs) {
                queue[id] = msg.copy(status = MessageStatus.FAILED)
                changed = true
            }
        }
        if (changed) publish()
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

    companion object {
        /** Default unacked-send timeout: 10 seconds. */
        const val DEFAULT_UNACKED_TIMEOUT_MS: Long = 10_000L
    }
}
