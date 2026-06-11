package io.sentient.mobiledata.outbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OutboundCacheTest {

    @Test
    fun enqueue_adds_queued() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        val p = cache.pending.value
        assertEquals(1, p.size)
        assertEquals("p1", p[0].id)
        assertEquals("hi", p[0].text)
        assertEquals(MessageStatus.QUEUED, p[0].status)
    }

    @Test
    fun queued_excludes_flushed_entries() {
        val cache = OutboundCache()
        cache.enqueue("p1", "a")
        cache.enqueue("p2", "b")
        cache.markFlushed("p1")
        // p1 is flushed (still QUEUED for display) — only p2 is flushable.
        assertEquals(listOf("p2"), cache.queued().map { it.id })
        assertEquals(MessageStatus.QUEUED, cache.pending.value.first { it.id == "p1" }.status)
        assertTrue(cache.pending.value.first { it.id == "p1" }.flushed)
    }

    @Test
    fun flushed_then_remove_reconciles() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFlushed("p1")
        // No SENT state — stays QUEUED for display until the echo removes it.
        assertEquals(MessageStatus.QUEUED, cache.pending.value[0].status)
        assertTrue(cache.pending.value[0].flushed)
        cache.remove("p1")
        assertTrue(cache.pending.value.isEmpty())
    }

    @Test
    fun markFailed_keeps_visible_and_retry_requeues() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value[0].status)
        cache.retry("p1")
        assertEquals(MessageStatus.QUEUED, cache.pending.value[0].status)
        // retry clears the flush guard so the next flush re-sends it.
        assertTrue(!cache.pending.value[0].flushed)
        assertEquals(listOf("p1"), cache.queued().map { it.id })
    }

    @Test
    fun markFailed_on_flushed_entry_is_noop_stays_queued() {
        // A flushed entry is in-flight (transport holds it). A disconnect must NOT mark it
        // FAILED — doing so would allow retry to re-send a message the gateway may already
        // have committed, producing a double-send.
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFlushed("p1")
        // Simulate disconnect triggering markFailed on the in-flight entry.
        cache.markFailed("p1")
        val entry = cache.pending.value.first { it.id == "p1" }
        assertEquals(MessageStatus.QUEUED, entry.status, "flushed entry must stay QUEUED, not FAILED")
        assertTrue(entry.flushed, "flushed flag must be preserved")
    }

    @Test
    fun markFailed_on_unflushed_queued_entry_transitions_to_failed() {
        // An unflushed QUEUED entry was never handed to the transport; it is safe to fail
        // and allow retry.
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value.first { it.id == "p1" }.status)
    }

    @Test
    fun never_resurrects_a_flushed_id_on_reenqueue() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFlushed("p1")
        cache.enqueue("p1", "hi") // same id, already flushed → ignored
        assertTrue(cache.pending.value[0].flushed)
        assertTrue(cache.queued().isEmpty(), "a flushed entry is not flushable again")
    }
}
