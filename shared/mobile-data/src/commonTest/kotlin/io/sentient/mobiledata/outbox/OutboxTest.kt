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
    fun reenqueue_of_flushed_id_does_not_resurrect_or_double_send() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()                                   // m1 flushed (stays QUEUED)
        ob.enqueue(PendingMessage("m1", "hello-again")) // same id, already flushed
        ob.onReady()
        assertEquals(1, sent.size)                     // not re-sent
        val m1 = ob.snapshot().first()
        assertEquals(MessageStatus.QUEUED, m1.status)  // no SENT state — stays QUEUED
        assertTrue(m1.flushed)                          // flushed guard intact, not resurrected
    }

    @Test
    fun failAll_leaves_flushed_entries_untouched() {
        val ob = Outbox(send = {})
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.onReady()                                   // m1 flushed (QUEUED, awaiting echo)
        ob.enqueue(PendingMessage("m2", "world"))      // m2 stays QUEUED, unflushed
        ob.failAll("auth dead")
        val snap = ob.snapshot().associateBy { it.id }
        assertEquals(MessageStatus.QUEUED, snap["m1"]?.status)   // flushed → untouched (not failed)
        assertEquals(MessageStatus.FAILED, snap["m2"]?.status)   // unflushed → failed
    }

    @Test
    fun retry_resets_failed_to_queued_and_onReady_sends_it() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        ob.failAll("auth dead")
        assertEquals(MessageStatus.FAILED, ob.snapshot().first().status)

        ob.retry("m1")
        assertEquals(MessageStatus.QUEUED, ob.snapshot().first().status)

        ob.onReady()
        assertEquals(listOf("hello"), sent)    // flushed after retry
        assertEquals(MessageStatus.QUEUED, ob.snapshot().first().status)  // no SENT state
        assertTrue(ob.snapshot().first().flushed)
    }

    @Test
    fun retry_is_noop_for_non_failed_message() {
        val sent = mutableListOf<String>()
        val ob = Outbox(send = { sent.add(it.text) })
        ob.enqueue(PendingMessage("m1", "hello"))
        // m1 is QUEUED — retry should not change it
        ob.retry("m1")
        assertEquals(MessageStatus.QUEUED, ob.snapshot().first().status)

        ob.onReady()
        // sent once — QUEUED stays QUEUED but is now flushed (guard against re-send)
        assertEquals(1, sent.size)
        assertTrue(ob.snapshot().first().flushed)

        // retry on a flushed (QUEUED, not FAILED) entry is a no-op
        ob.retry("m1")
        assertTrue(ob.snapshot().first().flushed)
    }

    @Test
    fun retry_unknown_id_is_noop() {
        val ob = Outbox(send = {})
        ob.retry("nonexistent")  // must not throw
        assertTrue(ob.snapshot().isEmpty())
    }
}
