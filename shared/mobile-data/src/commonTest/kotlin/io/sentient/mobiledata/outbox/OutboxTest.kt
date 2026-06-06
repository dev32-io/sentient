package io.sentient.mobiledata.outbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OutboxTest {
    @Test
    fun holds_when_not_ready_then_flushes_in_order() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.enqueue(PendingMessage("m2", "world"))
        assertTrue(sent.isEmpty())          // not ready yet
        ob.onReady()
        assertEquals(listOf("hello", "world"), sent)
    }

    @Test
    fun does_not_double_send_after_second_ready() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()
        ob.onReady()                         // reconnect re-fires ready
        assertEquals(1, sent.size)           // dedup — no double send
    }

    @Test
    fun fail_marks_pending_failed() {
        val ob = Outbox(send = {})
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.failAll("auth dead")
        assertEquals(MessageStatus.FAILED, ob.snapshot().first().status)
    }
}
