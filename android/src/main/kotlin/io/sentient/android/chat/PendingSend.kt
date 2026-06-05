package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus

/**
 * Outbox for sends issued before READY (web-sdk parity: queue, flush on ready).
 * Ordered FIFO — every queued send is preserved and drained in order, matching the
 * iOS SendQueue, so a not-ready window (new-chat / reconnect) never silently drops a
 * message even if the user submits twice before the socket reaches READY.
 */
data class PendingSend(val items: List<String>) {
    /** Append the next queued text (FIFO). */
    fun enqueue(next: String): PendingSend = copy(items = items + next)

    /** Returns ALL queued texts in order when [status] is READY (flush), else null. */
    fun flushIfReady(status: SdkStatus): List<String>? =
        if (status == SdkStatus.READY) items else null
}
