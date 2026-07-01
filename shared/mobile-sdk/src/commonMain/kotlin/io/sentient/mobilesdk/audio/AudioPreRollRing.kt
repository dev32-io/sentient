package io.sentient.mobilesdk.audio

// Retained for Slice 2 (downlink playback-window reuse); not wired into the current uplink.
// ---------------------------------------------------------------------------
// AudioPreRollRing — capture-side pre-roll + hangover buffer.
//
// Port of shared/web-sdk/src/audio-pre-roll-ring.ts.
//
// PROBLEM
// -------
// The client-side EchoGate drops mic frames whose RMS falls below a baseline
// threshold. When real speech begins its leading 1–2 frames are often quiet
// (vowel ramp-up, partial frame of silence before the syllable) and get
// dropped — STT misses the utterance head. Symmetrically, trailing low-energy
// phonemes drop off the tail, and mid-sentence dips engage the gateway's
// silence-carrier, which causes Silero VAD to fire end-of-speech early.
//
// DESIGN
// ------
// A small ring placed between the EchoGate decision and the upstream send.
// Every captured frame is run through the gate; instead of dropping rejected
// frames outright, the last N are buffered (pre-roll). On a reject→accept
// transition the buffer is flushed ahead of the accepted frame. On an
// accept→reject transition frames are kept emitting for M more frames
// (hangover) before going silent.
//
// STATE MACHINE (mirrors audio-pre-roll-ring.ts verbatim)
// --------------------------------------------------------
//   idle (last frame rejected, ring filling)
//     — accept → flush ring, emit frame → active
//     — reject → push to ring (trim), emit nothing
//
//   active (last frame accepted, hangover counter armed)
//     — accept → emit frame, re-arm hangover, stay active
//     — reject → emit frame, decrement hangover; → idle when counter hits 0
//              → if hangoverRemaining already 0 on entry: idle immediately
//
// BRANCH ORDER (verified against TS, line by line)
// --------------------------------------------------
// 1. accepted=true, !active  → onset: flush ring + frame, go active
// 2. accepted=true, active   → re-arm hangover, return [frame]
// 3. accepted=false, active, hangoverRemaining > 0
//      → decrement; if hits 0, go idle; return [frame]
// 4. accepted=false, active, hangoverRemaining == 0
//      → go idle (fall through to idle branch)
// 5. accepted=false, idle, preRollFrames == 0 → return empty
// 6. accepted=false, idle    → push to ring, trim to preRollFrames, return empty
//
// TS PARITY NOTE
// --------------
// The reference Kotlin impl in the task plan matches the TS exactly. No
// corrections were required — branch ordering and off-by-one (trim uses
// `> preRollFrames`, not `>=`) agree with the TS source.
// ---------------------------------------------------------------------------

/** Maximum frames to retain ahead of the next accepted frame (pre-roll size). */
private const val MIN_FRAMES = 0

/**
 * AudioPreRollRing gates mic uplink with a pre-roll buffer and a hangover tail.
 *
 * Generic over [T] so it works with any frame type (ByteArray, ShortArray, Int
 * in tests). Pure logic — no platform deps, no clocks, no logging.
 *
 * @param preRollFrames Number of below-threshold frames to retain before onset.
 *                      Must be >= 0.
 * @param hangoverFrames Number of below-threshold frames to keep emitting after
 *                       an accepted streak. Must be >= 0.
 */
class AudioPreRollRing<T>(
    private val preRollFrames: Int,
    private val hangoverFrames: Int,
) {
    init {
        require(preRollFrames >= MIN_FRAMES) {
            "AudioPreRollRing: preRollFrames must be >= 0, got $preRollFrames"
        }
        require(hangoverFrames >= MIN_FRAMES) {
            "AudioPreRollRing: hangoverFrames must be >= 0, got $hangoverFrames"
        }
    }

    private val ring = ArrayDeque<T>()
    private var active = false
    private var hangoverRemaining = 0

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Feed one captured frame with the EchoGate's accept/reject verdict.
     *
     * Returns the frames that should be forwarded to STT in order — may be
     * empty (silence is being buffered) or contain multiple frames (the
     * pre-roll flush on a reject→accept transition).
     */
    fun push(frame: T, accepted: Boolean): List<T> {
        if (accepted) {
            return if (!active) {
                // Onset: flush pre-roll ring + accepted frame, go active.
                val flush = ring.toMutableList()
                ring.clear()
                flush.add(frame)
                active = true
                hangoverRemaining = hangoverFrames
                flush
            } else {
                // Already active: re-arm hangover, pass frame through.
                hangoverRemaining = hangoverFrames
                listOf(frame)
            }
        }

        if (active) {
            if (hangoverRemaining > 0) {
                hangoverRemaining--
                if (hangoverRemaining == 0) active = false
                return listOf(frame)
            }
            // Hangover exhausted — fall through to idle buffering.
            active = false
        }

        // Idle: buffer the frame in the pre-roll ring (no-op if size is 0).
        if (preRollFrames == 0) return emptyList()
        ring.addLast(frame)
        while (ring.size > preRollFrames) ring.removeFirst()
        return emptyList()
    }

    /** Drop the ring and reset to idle. Use on session boundaries. */
    fun reset() {
        ring.clear()
        active = false
        hangoverRemaining = 0
    }
}
