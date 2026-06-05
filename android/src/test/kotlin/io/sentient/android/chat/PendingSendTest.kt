package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the outbox contract: sends issued before READY are NOT lost — they are queued
 * in order and flushed in order on the READY transition (web-sdk parity, matching the
 * iOS SendQueue). Two sends in the not-ready window both survive.
 */
class PendingSendTest {

    @Test fun `flushesWhenReady`() {
        val pending = PendingSend(listOf("hi"))
        assertEquals(listOf("hi"), pending.flushIfReady(SdkStatus.READY))
    }

    @Test fun `holdsWhileNotReady`() {
        val pending = PendingSend(listOf("waiting"))
        assertNull(pending.flushIfReady(SdkStatus.CONNECTING))
        assertNull(pending.flushIfReady(SdkStatus.RECONNECTING))
    }

    @Test fun `enqueuePreservesOrder`() {
        val pending = PendingSend(listOf("a")).enqueue("b")
        assertEquals(listOf("a", "b"), pending.items)
    }

    @Test fun `drainsAllInOrderOnReady`() {
        val pending = PendingSend(listOf("a")).enqueue("b")
        assertEquals(listOf("a", "b"), pending.flushIfReady(SdkStatus.READY))
    }
}
