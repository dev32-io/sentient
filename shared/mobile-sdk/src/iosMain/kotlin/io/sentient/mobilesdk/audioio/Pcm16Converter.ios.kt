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

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.get
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.pointed
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.AVFAudio.AVAudioConverter
import platform.AVFAudio.AVAudioConverterInputStatus_HaveData
import platform.AVFAudio.AVAudioConverterInputStatus_NoDataNow
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioFrameCount
import platform.AVFAudio.AVAudioPCMBuffer
import platform.AVFAudio.AVAudioPCMFormatInt16

private val log = createLogger("audioio", "converter", "ios")

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

    // Throttle for the per-call convert trace: log the first few + every Nth (failures
    // and the first success are what matter — this keeps the vitals ring from flooding).
    private var callCount = 0

    /**
     * Convert one input [buffer] to a PCM16 LE [ByteArray], or null on failure /
     * empty output. Drives the converter's pull block with the single tap buffer.
     * Logs the outcome (throttled) so the uplink trace shows convert ok/fail+reason.
     */
    fun convert(buffer: AVAudioPCMBuffer): ByteArray? {
        callCount += 1
        val conv = converter ?: return logFail("no-converter", buffer.frameLength)
        val capacity = estimateOutputFrames(buffer.frameLength)
        if (capacity == 0u) return logFail("zero-capacity", buffer.frameLength)
        val out = AVAudioPCMBuffer(pCMFormat = outputFormat, frameCapacity = capacity)
        val err = runConvert(conv, out, buffer)
        if (err != null) return logFail("converter-error: $err", buffer.frameLength)
        val bytes = extractPcm16Le(out) ?: return logFail("empty-output outFrames=${out.frameLength}", buffer.frameLength)
        if (shouldTrace()) {
            log.debug(
                "convert-ok",
                mapOf("inFrames" to buffer.frameLength.toLong(), "outFrames" to out.frameLength.toLong(), "bytes" to bytes.size),
            )
        }
        return bytes
    }

    /** Drives the converter's single-buffer pull; returns the NSError description or null. */
    private fun runConvert(conv: AVAudioConverter, out: AVAudioPCMBuffer, buffer: AVAudioPCMBuffer): String? = memScoped {
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<platform.Foundation.NSError?>>()
        var delivered = false
        conv.convertToBuffer(out, error = errVar.ptr) { _, statusPtr ->
            val status = statusPtr ?: return@convertToBuffer null
            if (delivered) {
                // NoDataNow — NOT EndOfStream. This converter instance is REUSED across
                // every tap buffer; EndOfStream is terminal — it permanently marks the
                // input stream finished, so the first convert() works and every later one
                // emits 0 frames forever. NoDataNow means "no more input this call": the
                // converter returns its resampled output (InputRanDry) and stays alive.
                status.pointed.value = AVAudioConverterInputStatus_NoDataNow
                null
            } else {
                delivered = true
                status.pointed.value = AVAudioConverterInputStatus_HaveData
                buffer
            }
        }
        errVar.value?.localizedDescription
    }

    /** Logs a convert failure with its reason (always — failures are rare + critical) and returns null. */
    private fun logFail(reason: String, inFrames: AVAudioFrameCount): ByteArray? {
        log.warn("convert-fail", mapOf("reason" to reason, "inFrames" to inFrames.toLong(), "call" to callCount))
        return null
    }

    /** First few calls + every Nth: keeps the success trace visible without flooding. */
    private fun shouldTrace(): Boolean = callCount <= TRACE_FIRST_CALLS || callCount % TRACE_EVERY == 0

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

        // convert() success-trace throttle: log the first N calls + every Nth after.
        const val TRACE_FIRST_CALLS = 3
        const val TRACE_EVERY = 100
    }
}
