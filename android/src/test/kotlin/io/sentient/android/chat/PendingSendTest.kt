package io.sentient.android.chat

import io.sentient.mobilesdk.transport.SdkStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the one-slot outbox contract: a send issued before READY is not lost —
 * it is queued and flushed on the READY transition (web-sdk parity).
 */
class PendingSendTest {

    @Test fun `flushesWhenReady`() {
        val pending = PendingSend("hi")
        assertEquals("hi", pending.flushIfReady(SdkStatus.READY))
    }

    @Test fun `holdsWhileNotReady`() {
        val pending = PendingSend("waiting")
        assertNull(pending.flushIfReady(SdkStatus.CONNECTING))
        assertNull(pending.flushIfReady(SdkStatus.RECONNECTING))
    }

    @Test fun `coalescesToLatest`() {
        assertEquals("new", PendingSend("old").enqueue("new").text)
    }
}
