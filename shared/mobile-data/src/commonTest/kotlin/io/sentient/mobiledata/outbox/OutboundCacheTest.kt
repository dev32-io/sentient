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
    fun queued_lists_only_queued() {
        val cache = OutboundCache()
        cache.enqueue("p1", "a")
        cache.enqueue("p2", "b")
        cache.markSent("p1")
        assertEquals(listOf("p2"), cache.queued().map { it.id })
    }

    @Test
    fun markSent_then_remove_reconciles() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        assertEquals(MessageStatus.SENT, cache.pending.value[0].status)
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
    }

    @Test
    fun never_resurrects_a_non_queued_id_on_reenqueue() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        cache.enqueue("p1", "hi")
        assertEquals(MessageStatus.SENT, cache.pending.value[0].status)
    }
}
