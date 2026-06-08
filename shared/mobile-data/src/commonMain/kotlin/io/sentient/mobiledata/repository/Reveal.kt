package io.sentient.mobiledata.repository

/** Events consumed by the reveal reducer alongside [io.sentient.mobilesdk.protocol.SdkEvent]. */
sealed class RevealEvent {
    data class Tick(val nowMs: Long) : RevealEvent()
}

/**
 * Typewriter pacing — ports webui src/config/typewriter.ts.
 *
 * Pure: no coroutines, no I/O. Returns the number of extra characters to reveal
 * on this tick; callers add it to the current [revealed] cursor.
 */
object RevealRate {
    const val BASE = 30.0
    const val MIN = 15.0
    const val MAX = 150.0
    const val GAP_GAIN = 0.02

    /**
     * @param revealed   Characters already visible.
     * @param fullLen    Total characters in the full text.
     * @param dtMs       Elapsed milliseconds since the last tick.
     * @param drain      True when in DRAINING phase (use MAX rate to finish fast).
     * @return           Number of additional characters to reveal this tick.
     */
    fun advance(revealed: Int, fullLen: Int, dtMs: Long, drain: Boolean): Int {
        if (revealed >= fullLen) return 0
        val gap = (fullLen - revealed).toDouble()
        val rate = if (drain) MAX else (BASE * (1 + gap * GAP_GAIN)).coerceIn(MIN, MAX)
        return (rate * dtMs / 1000.0).toInt().coerceAtMost(fullLen - revealed)
    }
}

/** Phase of the live in-flight bubble. */
enum class LivePhase { STREAMING, DRAINING }
