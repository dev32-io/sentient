// ---------------------------------------------------------------------------
// CaptureSession.android.kt — AudioRecord session handle + PCM16 resampler.
//
// Holds the live AudioRecord + optional AcousticEchoCanceler for one capture
// run, plus a linear resampler that downsamples the captured mono PCM16 to the
// gateway-negotiated target rate when the hardware can't capture 16k natively.
// When captureRate == targetRate the resampler is a straight little-endian
// packer (no interpolation). Release tears both effects + record down once.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import android.media.AudioRecord
import android.media.audiofx.AcousticEchoCanceler
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("audioio", "capture", "android", "session")

private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BYTE_MASK = 0xFF
private const val BYTE_SHIFT = 8

/**
 * One AudioRecord capture run.
 *
 * @param record live AudioRecord (recording).
 * @param aec attached canceler, or null when the platform has none.
 * @param captureRate the rate the hardware is actually capturing at.
 * @param captureFrameSamples samples read per loop iteration (frameDurationMs worth at captureRate).
 */
internal class CaptureSession(
    val record: AudioRecord,
    private val aec: AcousticEchoCanceler?,
    private val captureRate: Int,
    val captureFrameSamples: Int,
) {
    /** Builds the resampler for [targetRate] (pass-through when rates match). */
    fun resampler(targetRate: Int): Pcm16Resampler =
        Pcm16Resampler(captureRate, targetRate)

    fun release() {
        runCatching { record.stop() }.onFailure { log.warn("stop-failed", mapOf("code" to "operation-failure")) }
        runCatching { record.release() }.onFailure { log.warn("release-failed", mapOf("code" to "operation-failure")) }
        runCatching { aec?.release() }.onFailure { log.warn("aec-release-failed", mapOf("code" to "operation-failure")) }
        log.debug("released")
    }
}

/**
 * Linear-interpolation downsampler from [sourceRate] to [targetRate], emitting
 * little-endian PCM16 bytes. Pass-through (direct LE pack) when the rates match.
 *
 * Stateless across calls (each input frame resampled independently); good enough
 * for STT-grade 16k downmix. The on-device resample only runs when the hardware
 * rejected the native 16k request (logged once at session open).
 */
internal class Pcm16Resampler(
    private val sourceRate: Int,
    private val targetRate: Int,
) {
    /** Converts the first [length] samples of [src] (at sourceRate) to PCM16 LE at targetRate. */
    fun toPcm16Le(src: ShortArray, length: Int): ByteArray {
        if (sourceRate == targetRate) return packLe(src, length)
        val outSamples = (length.toLong() * targetRate / sourceRate).toInt()
        val out = ByteArray(outSamples * BYTES_PER_PCM16_SAMPLE)
        val ratio = sourceRate.toDouble() / targetRate.toDouble()
        for (i in 0 until outSamples) {
            val srcPos = i * ratio
            val idx = srcPos.toInt()
            val frac = srcPos - idx
            val a = src[idx.coerceIn(0, length - 1)].toInt()
            val b = src[(idx + 1).coerceIn(0, length - 1)].toInt()
            val sample = (a + (b - a) * frac).toInt()
            writeLe(out, i, sample)
        }
        return out
    }

    private fun packLe(src: ShortArray, length: Int): ByteArray {
        val out = ByteArray(length * BYTES_PER_PCM16_SAMPLE)
        for (i in 0 until length) writeLe(out, i, src[i].toInt())
        return out
    }

    private fun writeLe(out: ByteArray, sampleIndex: Int, sample: Int) {
        val base = sampleIndex * BYTES_PER_PCM16_SAMPLE
        out[base] = (sample and BYTE_MASK).toByte()
        out[base + 1] = ((sample shr BYTE_SHIFT) and BYTE_MASK).toByte()
    }
}
