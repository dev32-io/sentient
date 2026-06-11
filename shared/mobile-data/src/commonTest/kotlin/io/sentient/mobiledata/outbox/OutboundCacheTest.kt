package io.sentient.mobiledata.outbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Minimal mutable clock for tests — no platform dependency.
private class MutableClock(var nowMs: Long = 0L) : io.sentient.mobilesdk.util.Clock {
    override fun nowMs(): Long = nowMs
}

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
        assertNull(p[0].sentAtMs, "sentAtMs must be null before markSent")
    }

    // ── Resend-safe (was 3.2) ────────────────────────────────────────────────

    @Test
    fun `queued includes a previously sent-but-unechoed entry so reconnect re-sends`() {
        // Gateway dedups by pendingId; re-sending a sent-but-unechoed entry is safe.
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")
        cache.markSent("p1")  // sent once; echo never arrived
        assertEquals(listOf("p1"), cache.queued().map { it.id }, "resendable on reconnect")
    }

    @Test
    fun `markFailed fails a sent-but-unechoed entry on disconnect`() {
        // Any QUEUED entry — sent or unsent — can be failed on disconnect.
        val cache = OutboundCache()
        cache.enqueue("p1", "hello")
        cache.markSent("p1")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value.first { it.id == "p1" }.status)
    }

    // ── Unacked-timeout (was 3.3) ─────────────────────────────────────────────

    @Test
    fun `an unacked sent message times out to FAILED`() {
        val clock = MutableClock(0L)
        val cache = OutboundCache(clock = clock, unackedTimeoutMs = 10_000L)
        cache.enqueue("p1", "hello")
        cache.markSent("p1")
        clock.nowMs = 10_001L
        cache.sweepTimeouts()
        assertEquals(MessageStatus.FAILED, cache.pending.value.first { it.id == "p1" }.status)
    }

    @Test
    fun `sweepTimeouts does not fail a still-fresh sent message`() {
        val clock = MutableClock(0L)
        val cache = OutboundCache(clock = clock, unackedTimeoutMs = 10_000L)
        cache.enqueue("p1", "hello")
        cache.markSent("p1")
        clock.nowMs = 5_000L
        cache.sweepTimeouts()
        assertEquals(MessageStatus.QUEUED, cache.pending.value.first { it.id == "p1" }.status)
    }

    @Test
    fun `sweepTimeouts is a no-op for unsent entries with null sentAtMs`() {
        val clock = MutableClock(99_999L)
        val cache = OutboundCache(clock = clock, unackedTimeoutMs = 10_000L)
        cache.enqueue("p1", "hello")  // never markSent
        cache.sweepTimeouts()
        assertEquals(MessageStatus.QUEUED, cache.pending.value.first { it.id == "p1" }.status)
    }

    @Test
    fun `sweepTimeouts only fails timed-out entries leaving fresh entries untouched`() {
        val clock = MutableClock(0L)
        val cache = OutboundCache(clock = clock, unackedTimeoutMs = 10_000L)
        cache.enqueue("p1", "old")
        cache.enqueue("p2", "fresh")
        cache.markSent("p1")
        clock.nowMs = 5_000L
        cache.markSent("p2")  // sent 5s later
        clock.nowMs = 10_001L  // p1 is 10001ms since sent; p2 is 5001ms (not yet expired)
        cache.sweepTimeouts()
        assertEquals(MessageStatus.FAILED, cache.pending.value.first { it.id == "p1" }.status, "p1 timed out")
        assertEquals(MessageStatus.QUEUED, cache.pending.value.first { it.id == "p2" }.status, "p2 still fresh")
    }

    // ── Core FSM ─────────────────────────────────────────────────────────────

    @Test
    fun markSent_records_sentAtMs_and_stays_queued() {
        val clock = MutableClock(1_234L)
        val cache = OutboundCache(clock = clock)
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        val entry = cache.pending.value.first { it.id == "p1" }
        assertEquals(MessageStatus.QUEUED, entry.status)
        assertEquals(1_234L, entry.sentAtMs)
    }

    @Test
    fun markFailed_on_unsent_queued_entry_transitions_to_failed() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value.first { it.id == "p1" }.status)
    }

    @Test
    fun markFailed_keeps_visible_and_retry_requeues() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        assertEquals(MessageStatus.FAILED, cache.pending.value[0].status)
        cache.retry("p1")
        val entry = cache.pending.value[0]
        assertEquals(MessageStatus.QUEUED, entry.status)
        assertNull(entry.sentAtMs, "retry clears sentAtMs so next flush re-sends without stale timestamp")
        assertEquals(listOf("p1"), cache.queued().map { it.id })
    }

    @Test
    fun flushed_then_remove_reconciles() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        // No SENT state — stays QUEUED for display until the echo removes it.
        assertEquals(MessageStatus.QUEUED, cache.pending.value[0].status)
        cache.remove("p1")
        assertTrue(cache.pending.value.isEmpty())
    }

    @Test
    fun never_resurrects_a_failed_id_on_reenqueue() {
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markFailed("p1")
        cache.enqueue("p1", "hi-again")  // same id, already FAILED → ignored
        assertEquals(MessageStatus.FAILED, cache.pending.value.single().status)
    }

    @Test
    fun never_resurrects_a_sent_queued_id_on_reenqueue() {
        // A sent-but-unechoed entry is tracked — re-enqueuing the same id is a no-op.
        val cache = OutboundCache()
        cache.enqueue("p1", "hi")
        cache.markSent("p1")
        cache.enqueue("p1", "hi-again")  // same id, already QUEUED → ignored
        assertEquals(1, cache.pending.value.size, "no duplicate entry")
        assertEquals("hi", cache.pending.value.single().text, "original text preserved")
    }
}
