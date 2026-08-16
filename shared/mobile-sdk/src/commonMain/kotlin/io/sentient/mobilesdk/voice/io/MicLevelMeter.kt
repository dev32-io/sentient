package io.sentient.mobilesdk.voice.io

import kotlin.math.ln
import kotlin.math.sqrt

/** A UI-safe snapshot of the recent microphone energy. It intentionally contains no audio data. */
data class MicLevelEnvelope(
    val active: Boolean,
    val values: List<Float>,
) {
    init {
        require(values.size == MicLevelMeter.BAR_COUNT)
        require(values.all { it.isFinite() && it in 0f..1f })
    }

    companion object {
        fun silence(): MicLevelEnvelope = MicLevelEnvelope(false, List(MicLevelMeter.BAR_COUNT) { MicLevelMeter.SILENCE })
    }
}

/** Converts post-gain, 16 kHz PCM into fixed-duration aggregate levels. */
class MicLevelMeter(
    private val onEnvelope: (MicLevelEnvelope) -> Unit,
) {
    private var sampleCount = 0
    private var squareSum = 0.0
    private var history = FloatArray(BAR_COUNT) { SILENCE }
    private var last = SILENCE

    fun accept(samples: ShortArray) {
        for (sample in samples) {
            val normalized = sample / 32768.0
            squareSum += normalized * normalized
            sampleCount++
            if (sampleCount == WINDOW_SAMPLES) {
                emitWindow()
                sampleCount = 0
                squareSum = 0.0
            }
        }
    }

    fun reset() {
        sampleCount = 0
        squareSum = 0.0
        history = FloatArray(BAR_COUNT) { SILENCE }
        last = SILENCE
        onEnvelope(MicLevelEnvelope.silence())
    }

    private fun emitWindow() {
        val rms = sqrt(squareSum / WINDOW_SAMPLES)
        val boundedRms = rms.coerceIn(RMS_FLOOR, RMS_CEILING)
        val mapped = ((ln(boundedRms) - ln(RMS_FLOOR)) / (ln(RMS_CEILING) - ln(RMS_FLOOR)))
            .toFloat().coerceIn(0f, 1f)
        // Fast attack, slower release preserves short words without making silence twitchy.
        val smoothed = if (mapped >= last) {
            last + (mapped - last) * ATTACK
        } else {
            last + (mapped - last) * RELEASE
        }
        last = smoothed.coerceIn(0f, 1f)
        for (i in 0 until BAR_COUNT - 1) history[i] = history[i + 1]
        history[BAR_COUNT - 1] = last
        onEnvelope(MicLevelEnvelope(true, history.toList()))
    }

    companion object {
        const val BAR_COUNT = 32
        const val WINDOW_SAMPLES = 800
        const val WINDOW_DURATION_MS = 50
        const val HISTORY_DURATION_MS = 1600
        const val RMS_FLOOR = 0.01
        const val RMS_CEILING = 0.5
        const val SILENCE = 0f
        private const val ATTACK = 0.65f
        private const val RELEASE = 0.18f
    }
}
