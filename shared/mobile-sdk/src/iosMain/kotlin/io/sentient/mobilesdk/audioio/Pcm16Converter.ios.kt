// ---------------------------------------------------------------------------
// Pcm16Converter.ios.kt — AVAudioConverter wrapper: input float buffer → PCM16 LE.
//
// The AVAudioEngine input tap hands us float32 buffers at the hardware rate
// (typically 48k). This wraps a single AVAudioConverter to resample + reformat
// each tap buffer to 16k mono interleaved PCM16, then copies the converter's
// int16ChannelData out as little-endian ByteArray frames the gateway expects.
//
// K/N AVFoundation cinterop notes:
//  • int16ChannelData is a CPointer<CPointerVar<Int16Var>> — channel 0 holds the
//    interleaved mono samples; reinterpret + index per-sample.
//  • convertToBuffer:error:withInputFromBlock: drives a pull model. The input
//    block returns the source buffer ONCE then signals EndOfStream so the
//    converter emits exactly the resampled output for that tap buffer (no
//    cross-buffer state needed for linear SRC at STT grade).
//  • Host-platform Int16 is little-endian, matching the PCM16 LE wire format —
//    a direct memcpy-style byte split is correct, no endian swap.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.audioio

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.get
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.pointed
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.AVFAudio.AVAudioConverter
import platform.AVFAudio.AVAudioConverterInputStatus_EndOfStream
import platform.AVFAudio.AVAudioConverterInputStatus_HaveData
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioFrameCount
import platform.AVFAudio.AVAudioPCMBuffer
import platform.AVFAudio.AVAudioPCMFormatInt16

private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BYTE_MASK = 0xFF
private const val BYTE_SHIFT = 8
private const val MONO_CHANNELS = 1u

/**
 * Reusable float→PCM16 converter targeting [targetSampleRate] mono.
 *
 * One instance per capture run; [convert] is called per tap buffer. Not
 * thread-safe — the tap delivers buffers serially on the audio thread.
 */
internal class Pcm16Converter(
    inputFormat: AVAudioFormat,
    private val targetSampleRate: Int,
) {
    private val inputSampleRate: Double = inputFormat.sampleRate

    private val outputFormat: AVAudioFormat = AVAudioFormat(
        commonFormat = AVAudioPCMFormatInt16,
        sampleRate = targetSampleRate.toDouble(),
        channels = MONO_CHANNELS,
        interleaved = true,
    )

    private val converter: AVAudioConverter? = AVAudioConverter(fromFormat = inputFormat, toFormat = outputFormat)

    /** True when the converter was constructed (format pair was acceptable). */
    val isReady: Boolean get() = converter != null

    /**
     * Convert one input [buffer] to a PCM16 LE [ByteArray], or null on failure /
     * empty output. Drives the converter's pull block with the single tap buffer.
     */
    fun convert(buffer: AVAudioPCMBuffer): ByteArray? {
        val conv = converter ?: return null
        val capacity = estimateOutputFrames(buffer.frameLength)
        if (capacity == 0u) return null
        val out = AVAudioPCMBuffer(pCMFormat = outputFormat, frameCapacity = capacity)

        var delivered = false
        val ok = memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<platform.Foundation.NSError?>>()
            conv.convertToBuffer(out, error = errVar.ptr) { _, statusPtr ->
                val status = statusPtr ?: return@convertToBuffer null
                if (delivered) {
                    status.pointed.value = AVAudioConverterInputStatus_EndOfStream
                    null
                } else {
                    delivered = true
                    status.pointed.value = AVAudioConverterInputStatus_HaveData
                    buffer
                }
            }
            errVar.value == null
        }
        if (!ok) return null
        return extractPcm16Le(out)
    }

    /** Output frame budget for a tap buffer of [inputFrames] (ratio + slack for rounding). */
    private fun estimateOutputFrames(inputFrames: AVAudioFrameCount): AVAudioFrameCount {
        val rate = if (inputSampleRate > 0.0) inputSampleRate else DEFAULT_INPUT_RATE_GUARD
        val ratio = targetSampleRate.toDouble() / rate
        return ((inputFrames.toDouble() * ratio).toLong() + CAPACITY_SLACK_FRAMES).toUInt()
    }

    /** Copies the converter's int16 channel-0 samples out as little-endian bytes. */
    private fun extractPcm16Le(out: AVAudioPCMBuffer): ByteArray? {
        val frames = out.frameLength.toInt()
        if (frames == 0) return null
        val channel = out.int16ChannelData?.get(0) ?: return null
        val bytes = ByteArray(frames * BYTES_PER_PCM16_SAMPLE)
        for (i in 0 until frames) {
            val sample = channel[i].toInt()
            bytes[i * BYTES_PER_PCM16_SAMPLE] = (sample and BYTE_MASK).toByte()
            bytes[i * BYTES_PER_PCM16_SAMPLE + 1] = ((sample shr BYTE_SHIFT) and BYTE_MASK).toByte()
        }
        return bytes
    }

    private companion object {
        // Fallback input rate if the format reports an unset (0) sample rate. The
        // real rate is whatever the hardware reports (often 48k); over-sizing the
        // output buffer is harmless (the converter writes only what it produces).
        const val DEFAULT_INPUT_RATE_GUARD = 48_000.0

        // Extra output frames so resample rounding never overflows the buffer.
        const val CAPACITY_SLACK_FRAMES = 16L
    }
}
