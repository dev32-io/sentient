package io.sentient.mobilesdk.voice.uplink

import io.sentient.mobilesdk.audio.computeRms

/**
 * Detects the speech-onset EDGE on the (AEC'd) mic for instant local barge-in ducking.
 * Returns true exactly once per quiet→speech transition after [sustainFrames] consecutive
 * above-threshold frames. NEVER gates/drops audio — the server owns endpointing.
 */
class OnsetDetector(private val threshold: Double, private val sustainFrames: Int) {
    private var consecutive = 0
    private var speaking = false

    fun observe(frame: ShortArray): Boolean {
        val loud = computeRms(frame) >= threshold
        if (!loud) { consecutive = 0; speaking = false; return false }
        consecutive += 1
        if (!speaking && consecutive >= sustainFrames) { speaking = true; return true }
        return false
    }

    fun reset() { consecutive = 0; speaking = false }
}
