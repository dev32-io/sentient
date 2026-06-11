// ---------------------------------------------------------------------------
// ResumeCursor — in-memory seq/epoch cursor for WS stream resumption.
//
// Mirrors web-sdk's resume-cursor.ts VERBATIM. Tracks the highest-seen seq per
// gateway epoch so that:
//   1. Binary audio frames can be deduped by their header seq (replay protection).
//   2. JSON frames with a `seq` field can be deduped similarly.
//   3. On reconnect, the cursor is sent via `stream.resume` so the gateway can
//      replay any frames the client missed during the outage.
//
// Design notes (parity with web):
//   - In-memory only (Slice 3). Slice 4 will persist.
//   - A fresh session (first connect) has cursor {epoch: 0, lastSeq: 0}. The
//     first real seq from the gateway will be 1 > 0, so it is applied — the
//     dedup NEVER drops the first/fresh frame.
//   - On `stream.resumed {recovered: false}` the caller MUST reset() the cursor
//     and REST-refetch history.
//   - On epoch change (gateway restarted mid-connection) seq resets; we track
//     the new epoch and reset lastSeq.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.log.createLogger

/** Immutable snapshot of a [ResumeCursor]'s position. */
data class CursorSnapshot(
    /** Gateway epoch for the current connection. 0 = not yet received. */
    val epoch: Long,
    /** Highest seq seen in the current epoch. 0 = none yet. */
    val lastSeq: Long,
)

/**
 * Mutable seq/epoch cursor. Single-threaded: the orchestrator drives [tryApply]
 * from one dispatcher (the WS pump). No coroutines, no platform types.
 */
class ResumeCursor {
    private val log = createLogger("transport", "resume-cursor")

    private var epoch: Long = 0
    private var lastSeq: Long = 0

    /** The current cursor position (read-only view for callers). */
    val snapshot: CursorSnapshot get() = CursorSnapshot(epoch, lastSeq)

    /**
     * Attempt to apply a frame with the given [seq] (and optional [incomingEpoch]).
     * Returns true if the frame should be processed; false if it should be dropped
     * as a duplicate or already-applied replay.
     *
     * Rules (mirror web-sdk):
     *   - seq == 0 means "no seq" — always pass through (legacy / non-seq frame).
     *   - If incomingEpoch is provided, non-zero, and differs from the tracked
     *     epoch, reset lastSeq to 0 and adopt the new epoch. Then apply normally.
     *   - seq <= lastSeq → DROP (already applied / replay overlap).
     *   - seq > lastSeq → APPLY, advance lastSeq.
     */
    fun tryApply(seq: Long, incomingEpoch: Long? = null): Boolean {
        if (seq == 0L) return true

        if (incomingEpoch != null && incomingEpoch != 0L && incomingEpoch != epoch) {
            log.debug("epoch-transition", mapOf("from" to epoch, "to" to incomingEpoch))
            epoch = incomingEpoch
            lastSeq = 0
        }

        if (seq <= lastSeq) {
            log.debug("dedup-drop", mapOf("seq" to seq, "lastSeq" to lastSeq, "epoch" to epoch))
            return false
        }
        lastSeq = seq
        return true
    }

    /** Overwrite the cursor. Used on fresh-session load (recovered:false). */
    fun reset(newEpoch: Long = 0, newLastSeq: Long = 0) {
        log.debug("reset", mapOf("epoch" to newEpoch, "lastSeq" to newLastSeq))
        epoch = newEpoch
        lastSeq = newLastSeq
    }
}
