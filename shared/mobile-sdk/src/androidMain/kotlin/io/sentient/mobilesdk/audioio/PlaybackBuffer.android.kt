// ---------------------------------------------------------------------------
// PlaybackBuffer.android.kt — playback-side ByteRing + byte-domain PCM16 resampler.
//
// ByteRing: a pre-allocated, drop-oldest ring for PCM16 LE bytes the AudioTrack
// couldn't accept on a non-blocking write (the decorator-rule "pre-allocate
// generously, drop-oldest on overflow" buffer; sized ~2s like the webui worklet
// ring). Single-threaded use — the E3 pipeline drives enqueue/clear serially.
//
// PlaybackResampler: linear-interpolation resampler over PCM16 LE bytes (input
// is already PCM16, unlike capture's ShortArray Pcm16Resampler). Pass-through is
// handled by the adapter (it only constructs this when rates differ).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BYTE_MASK = 0xFF
private const val BYTE_SHIFT = 8

/**
 * Fixed-capacity drop-oldest byte ring. Not thread-safe (serial enqueue path).
 *
 * On overflow the oldest bytes are discarded so the freshest assistant audio is
 * always retained — matching the webui ring's drop-oldest policy.
 */
internal class ByteRing(initialCapacity: Int) {
    private var buf = ByteArray(initialCapacity)
    private var count = 0

    fun isEmpty(): Boolean = count == 0
    fun size(): Int = count

    /** Resets to a fresh capacity (called at start with the negotiated-rate sizing). */
    fun reset(capacity: Int) {
        buf = ByteArray(capacity)
        count = 0
    }

    fun clear() {
        count = 0
    }

    /** Appends [length] bytes from [src] at [offset]; drops oldest on overflow. */
    fun push(src: ByteArray, offset: Int, length: Int) {
        if (length <= 0 || buf.isEmpty()) return
        if (length >= buf.size) {
            // Incoming chunk alone exceeds capacity: keep only the newest tail.
            src.copyInto(buf, 0, offset + length - buf.size, offset + length)
            count = buf.size
            return
        }
        if (count + length > buf.size) {
            val drop = count + length - buf.size
            buf.copyInto(buf, 0, drop, count)
            count -= drop
        }
        src.copyInto(buf, count, offset, offset + length)
        count += length
    }

    /** Copies out all buffered bytes and empties the ring. */
    fun drainAll(): ByteArray {
        val out = buf.copyOf(count)
        count = 0
        return out
    }
}

/**
 * Linear-interpolation resampler from [sourceRate] to [targetRate] over PCM16 LE
 * bytes. Stateless across calls (each frame resampled independently) — adequate
 * for the rare device-rate-mismatch path (downlink is normally 48k native).
 */
internal class PlaybackResampler(
    private val sourceRate: Int,
    private val targetRate: Int,
) {
    fun resampleLe(src: ByteArray): ByteArray {
        val srcSamples = src.size / BYTES_PER_PCM16_SAMPLE
        if (srcSamples == 0) return ByteArray(0)
        val outSamples = (srcSamples.toLong() * targetRate / sourceRate).toInt()
        val out = ByteArray(outSamples * BYTES_PER_PCM16_SAMPLE)
        val ratio = sourceRate.toDouble() / targetRate.toDouble()
        for (i in 0 until outSamples) {
            val srcPos = i * ratio
            val idx = srcPos.toInt()
            val frac = srcPos - idx
            val a = readLe(src, idx.coerceIn(0, srcSamples - 1))
            val b = readLe(src, (idx + 1).coerceIn(0, srcSamples - 1))
            writeLe(out, i, (a + (b - a) * frac).toInt())
        }
        return out
    }

    private fun readLe(src: ByteArray, sampleIndex: Int): Int {
        val base = sampleIndex * BYTES_PER_PCM16_SAMPLE
        val lo = src[base].toInt() and BYTE_MASK
        val hi = src[base + 1].toInt()
        return (hi shl BYTE_SHIFT) or lo
    }

    private fun writeLe(out: ByteArray, sampleIndex: Int, sample: Int) {
        val base = sampleIndex * BYTES_PER_PCM16_SAMPLE
        out[base] = (sample and BYTE_MASK).toByte()
        out[base + 1] = ((sample shr BYTE_SHIFT) and BYTE_MASK).toByte()
    }
}
