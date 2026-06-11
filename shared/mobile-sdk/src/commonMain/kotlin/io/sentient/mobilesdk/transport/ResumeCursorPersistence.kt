// ---------------------------------------------------------------------------
// ResumeCursorPersistence — the seed/save/clear coordinator between the in-memory
// [ResumeCursor] and a durable [ResumeCursorStore] (Task 4.7). Extracted from the
// orchestrator so SentientSdk stays a thin caller: it owns the save-coalescing
// dirty flag + the conversation-keyed load/save/clear, leaving the orchestrator to
// drive the three hooks at the right wire moments.
//
// Single-threaded contract (mirrors ResumeCursor): the orchestrator drives every
// method from the WS-pump dispatcher; no internal synchronization.
//
// The conversation key is supplied lazily (the SDK's currentSessionId moves) so this
// coordinator never holds a stale id — it reads the live anchor at each operation.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.log.createLogger

/**
 * Coordinates the durable persistence of a [cursor] against [store], keyed by the
 * conversation id from [conversationId]. Save writes are coalesced via [dirty]:
 * [noteAdvance] marks dirty, [flush] writes once.
 */
class ResumeCursorPersistence(
    private val cursor: ResumeCursor,
    private val store: ResumeCursorStore,
    private val conversationId: () -> String?,
) {
    private val log = createLogger("transport", "resume-cursor-persistence")

    // Save coalescing: noteAdvance marks dirty; flush (called at the cycle boundary)
    // writes ONE snapshot per cycle instead of one per applied frame.
    private var dirty = false

    /**
     * SEED: if the in-memory cursor is empty (lastSeq==0) AND a conversation is already
     * anchored, overwrite it with the persisted snapshot so the next resume carries the
     * durable epoch/seq. No-op when the cursor already has a seq or nothing is persisted.
     *
     * The anchor guard means this fires on an IN-PROCESS reconnect (the conversation is
     * still anchored — spec §6), NOT on a cold relaunch's first connect: the SDK does
     * not restore its session anchor on launch, so [conversationId] is null there and
     * the seed early-returns. Cold-relaunch resume (restore anchor → seed) is a follow-up.
     */
    fun seedIfEmpty() {
        if (cursor.snapshot.lastSeq != 0L) return
        val id = conversationId() ?: return
        val persisted = store.load(id) ?: return
        log.info("seed", mapOf("conversationId" to id, "epoch" to persisted.epoch, "lastSeq" to persisted.lastSeq))
        cursor.reset(newEpoch = persisted.epoch, newLastSeq = persisted.lastSeq)
    }

    /** Mark the cursor dirty after an advance, so the next [flush] persists it. */
    fun noteAdvance() {
        dirty = true
    }

    /**
     * SAVE (coalesced): persist the latest snapshot ONCE if it advanced since the last
     * flush. No-op when not dirty, when no conversation is anchored, or when the cursor
     * has no seq yet. Called at the cycle boundary.
     */
    fun flush() {
        if (!dirty) return
        val id = conversationId() ?: return          // dirty stays set — retried next flush
        val snapshot = cursor.snapshot
        if (snapshot.lastSeq == 0L) return            // dirty stays set
        dirty = false                                 // clear only once we're actually saving
        log.info("save", mapOf("conversationId" to id, "epoch" to snapshot.epoch, "lastSeq" to snapshot.lastSeq))
        store.save(id, snapshot)
    }

    /** CLEAR: drop the durable cursor for the anchored conversation (non-recovered reset). */
    fun clearAnchored() {
        dirty = false
        val id = conversationId() ?: return
        log.info("clear", mapOf("conversationId" to id))
        store.clear(id)
    }

    /**
     * CLEAR for an explicit [id] (conversation delete). Drops the dirty flag too when
     * the deleted conversation is the anchored one, so a pending flush can't resurrect it.
     */
    fun clearFor(id: String) {
        if (id == conversationId()) dirty = false
        log.info("clear", mapOf("conversationId" to id, "trigger" to "delete"))
        store.clear(id)
    }
}
