package io.sentient.mobilesdk.voice.uplink

import io.sentient.mobilesdk.voice.FRAME_SAMPLES_16K

/**
 * Accumulates variable-length 16k mono PCM and emits exact [frameSamples]-sample frames.
 * The platform tap hands variable buffers (iOS often ~4800 frames); downstream needs
 * exact 20ms frames. Sub-frame remainder is carried to the next push. Single-thread
 * (the pipeline dispatcher); not thread-safe by design.
 */
class Framer(val frameSamples: Int = FRAME_SAMPLES_16K) {
    init { require(frameSamples > 0) { "frameSamples must be positive, was $frameSamples" } }

    private var carry = ShortArray(0)

    fun push(pcm: ShortArray): List<ShortArray> {
        val joined = if (carry.isEmpty()) pcm else carry + pcm
        val full = joined.size / frameSamples
        if (full == 0) {
            carry = joined
            return emptyList()
        }
        val out = ArrayList<ShortArray>(full)
        for (i in 0 until full) {
            out.add(joined.copyOfRange(i * frameSamples, (i + 1) * frameSamples))
        }
        carry = joined.copyOfRange(full * frameSamples, joined.size)
        return out
    }

    fun reset() { carry = ShortArray(0) }
}
