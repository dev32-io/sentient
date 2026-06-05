package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus

/**
 * One-slot outbox for a send issued before READY (web-sdk parity: queue, flush on ready).
 * Latest-wins — a second queued send replaces the first.
 */
data class PendingSend(val text: String) {
    /** Replace this slot with the next queued text. Latest-wins. */
    fun enqueue(next: String): PendingSend = copy(text = next)

    /**
     * Returns the queued text when [status] is READY (flush), otherwise null (still queued).
     */
    fun flushIfReady(status: SdkStatus): String? = if (status == SdkStatus.READY) text else null
}
