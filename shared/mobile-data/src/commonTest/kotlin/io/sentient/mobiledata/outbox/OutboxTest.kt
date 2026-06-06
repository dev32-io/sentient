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

    @Test
    fun reenqueue_of_sent_id_does_not_resurrect_or_double_send() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()                                   // m1 sent
        ob.enqueue(PendingMessage("m1", "hello-again")) // same id, already SENT
        ob.onReady()
        assertEquals(1, sent.size)                     // not re-sent
        assertEquals(MessageStatus.SENT, ob.snapshot().first().status)  // stays SENT, not resurrected
    }

    @Test
    fun failAll_leaves_sent_entries_untouched() {
        val ob = Outbox(send = {})
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()                                   // m1 -> SENT
        ob.enqueue(PendingMessage("m2", "world"))      // m2 stays QUEUED
        ob.failAll("auth dead")
        val snap = ob.snapshot().associateBy { it.id }
        assertEquals(MessageStatus.SENT, snap["m1"]?.status)    // untouched
        assertEquals(MessageStatus.FAILED, snap["m2"]?.status)  // failed
    }
}
