package io.sentient.mobiledata.repository

import io.sentient.mobiledata.outbox.MessageStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * OutboxRepository — the optimistic-send FSM (queued → sent → failed) + the
 * conversation-switch reset. Synchronous: no scope/coroutines, read `pending.value`.
 */
class OutboxRepositoryTest {

    @Test
    fun send_adds_optimistic_queued_pending() {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val repo = OutboxRepository(send = { text, id -> sendCalls.add(text to id) }, newId = { "p1" })

        repo.send("hi")

        val p = repo.pending.value
        assertEquals(1, p.size)
        assertEquals("p1", p[0].id)
        assertEquals("hi", p[0].text)
        assertEquals(MessageStatus.QUEUED, p[0].status)
        // send callback NOT invoked yet — connection not ready
        assertTrue(sendCalls.isEmpty())
    }

    @Test
    fun onReady_flushes_pending_to_sent_and_invokes_send() {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val repo = OutboxRepository(send = { text, id -> sendCalls.add(text to id) }, newId = { "p1" })

        repo.send("hi")
        repo.setConnected(true)

        assertEquals(1, sendCalls.size)
        assertEquals("hi", sendCalls[0].first)
        assertEquals("p1", sendCalls[0].second)
        assertEquals(MessageStatus.SENT, repo.pending.value[0].status)
    }

    @Test
    fun send_while_connected_flushes_immediately() {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val repo = OutboxRepository(send = { text, id -> sendCalls.add(text to id) }, newId = { "p1" })

        repo.setConnected(true)
        repo.send("hi")

        assertEquals(1, sendCalls.size)
        assertEquals(MessageStatus.SENT, repo.pending.value[0].status)
    }

    @Test
    fun send_while_disconnected_stays_queued_until_connected() {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val repo = OutboxRepository(send = { text, id -> sendCalls.add(text to id) }, newId = { "p1" })

        repo.send("hi")
        assertTrue(sendCalls.isEmpty(), "no send while disconnected, got: $sendCalls")

        repo.setConnected(true)
        assertEquals(1, sendCalls.size)
        assertEquals("p1", sendCalls[0].second)
    }

    @Test
    fun failOutbox_marks_pending_failed_and_keeps_visible() {
        val repo = OutboxRepository(send = { _, _ -> }, newId = { "p1" })

        repo.send("hi")
        repo.failOutbox("auth dead")

        val p = repo.pending.value
        assertEquals(1, p.size)
        assertEquals(MessageStatus.FAILED, p[0].status)
    }

    @Test
    fun retry_requeues_failed_and_sends_when_connected() {
        val sendCalls = mutableListOf<Pair<String, String>>()
        val repo = OutboxRepository(send = { text, id -> sendCalls.add(text to id) }, newId = { "p1" })

        repo.send("hi")
        repo.failOutbox("auth dead")

        // connecting does NOT resend a FAILED message
        repo.setConnected(true)
        assertTrue(sendCalls.isEmpty(), "FAILED must not auto-send on reconnect, got: $sendCalls")
        assertEquals(MessageStatus.FAILED, repo.pending.value[0].status)

        // retry re-queues and flushes immediately (already connected)
        repo.retry("p1")
        assertEquals(1, sendCalls.size)
        assertEquals(MessageStatus.SENT, repo.pending.value[0].status)
    }

    // ── Conversation-switch reset (the leak fix) ─────────────────────────────

    @Test
    fun reset_drops_all_pending() {
        val repo = OutboxRepository(send = { _, _ -> }, newId = { "p1" })

        repo.send("hi")
        assertEquals(1, repo.pending.value.size)

        repo.reset()
        assertTrue(repo.pending.value.isEmpty(), "pending must be empty after a conversation switch")
    }
}
