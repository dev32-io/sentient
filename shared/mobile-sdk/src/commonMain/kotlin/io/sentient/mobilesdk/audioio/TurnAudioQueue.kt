// ---------------------------------------------------------------------------
// TurnAudioQueue — the per-turn downlink audio FIFO (design spec §7.2).
//
// The gateway NEVER stops its own audio (§4.6/§7.2): a self-initiated follow-up turn's
// TTS arrives while the previous turn's audio may still be playing, and it must QUEUE
// BEHIND it. Pre-2.0 the pipeline held ONE `activeCycleId` and treated a different id as
// a supersede — flushPlayback() + drop pending — which cut the tail off every follow-up
// turn. This structure replaces that single slot.
//
// One segment per turn, in arrival order. Only the HEAD segment streams into the player;
// a segment queued behind buffers its RAW WIRE bytes until promoted. Buffering the raw
// bytes (not decoded PCM) is what keeps the single stateful OGG-Opus decoder safe — a
// queued turn's chunks must never be fed through the decoder the head turn is using.
//
// Pure: no coroutines, no playback, no logging (AudioPipeline owns the log trail and the
// physical sink). Flushing is NOT this type's business — a flush is barge-in / interrupt
// only, and clears the whole queue via [clear].
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

/** One turn's downlink audio stream. [bufferedBytes] is non-zero only while queued behind. */
internal class TurnAudioSegment(val turnId: String, val opus: Boolean) {
    private val frames = ArrayDeque<ByteArray>()

    var bufferedBytes: Int = 0
        private set

    /** True once turn.audio.done landed — the gateway will send no more frames for it. */
    var streamDone: Boolean = false

    /** Depth of the deferred buffer (frames), for the log trail. */
    val depth: Int get() = frames.size

    /** Buffer one raw wire frame. Drops OLDEST past [maxBytes] (never the newest);
     *  returns the bytes dropped so the caller can log the degraded path. */
    fun buffer(frame: ByteArray, maxBytes: Int): Int {
        frames.addLast(frame)
        bufferedBytes += frame.size
        var dropped = 0
        while (bufferedBytes > maxBytes && frames.size > 1) {
            val old = frames.removeFirst()
            bufferedBytes -= old.size
            dropped += old.size
        }
        return dropped
    }

    /** Take every buffered frame in arrival order and empty the buffer. */
    fun takeBuffered(): List<ByteArray> {
        val out = frames.toList()
        frames.clear()
        bufferedBytes = 0
        return out
    }
}

/** FIFO of per-turn audio segments. [maxBufferedBytesPerTurn] bounds each queued turn's
 *  deferred buffer (drop-oldest), so a stalled head can never grow memory without limit. */
internal class TurnAudioQueue(private val maxBufferedBytesPerTurn: Int) {
    private val segments = ArrayDeque<TurnAudioSegment>()

    val head: TurnAudioSegment? get() = segments.firstOrNull()
    val depth: Int get() = segments.size
    val isEmpty: Boolean get() = segments.isEmpty()

    fun segmentFor(turnId: String): TurnAudioSegment? = segments.firstOrNull { it.turnId == turnId }

    fun isHead(turnId: String): Boolean = segments.firstOrNull()?.turnId == turnId

    /**
     * Open a segment for [turnId]. Returns true when it became the HEAD (nothing was
     * playing) and false when it queued BEHIND an in-flight turn. A duplicate
     * turn.audio.start never opens a second segment; it reports whether that turn is head.
     */
    fun open(turnId: String, opus: Boolean): Boolean {
        val existing = segmentFor(turnId)
        if (existing != null) return isHead(turnId)
        val fresh = segments.isEmpty()
        segments.addLast(TurnAudioSegment(turnId, opus))
        return fresh
    }

    /** Buffer a frame for a turn queued behind the head. Returns bytes dropped by the bound. */
    fun bufferBehind(turnId: String, frame: ByteArray): Int =
        segmentFor(turnId)?.buffer(frame, maxBufferedBytesPerTurn) ?: 0

    fun markStreamDone(turnId: String) {
        segmentFor(turnId)?.streamDone = true
    }

    /** Drop the head and return the next segment (now the head), or null when drained. */
    fun promote(): TurnAudioSegment? {
        segments.removeFirstOrNull()
        return segments.firstOrNull()
    }

    fun clear() = segments.clear()
}
