// ---------------------------------------------------------------------------
// MicAudioRecordSession.android.kt — AudioRecord ACQUISITION for AndroidMicSource.
//
// The acquisition concern split out of AndroidMicSource (mirrors the
// CaptureSession.android.kt split): resolve the capture rate (target-native or
// device-rate fallback), size the buffer from getMinBufferSize, construct the
// 5-arg VOICE_COMMUNICATION AudioRecord, verify STATE_INITIALIZED /
// RECORDSTATE_RECORDING, and build the (fallback-only) resampler. Every failure
// branch releases the record and returns a typed Acquisition result — NEVER
// throws across the start() boundary. NO stacked AEC/NS/AGC: VOICE_COMMUNICATION
// already provides platform AEC+NS, so attachAec() is deliberately NOT carried over.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.io

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import io.sentient.mobilesdk.audioio.Pcm16Resampler
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("voice", "mic", "android", "session")

private const val FALLBACK_CAPTURE_RATE = 48_000 // device rate when the hardware rejects the target rate
private const val MS_PER_SECOND = 1000
private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BUFFER_SIZE_MULTIPLIER = 4

/** One acquired AudioRecord run: live record + read sizing + (fallback) resampler. */
internal class ReaderConfig(val record: AudioRecord, val frameSamples: Int, val resampler: Pcm16Resampler?)

/** Typed acquisition outcome — never throws across the start() boundary. */
internal sealed interface Acquisition {
    data class Ready(val config: ReaderConfig) : Acquisition
    data class Failed(val reason: String) : Acquisition
}

/**
 * Acquires AudioRecord ([targetRate]-native or device-rate fallback resampled to [targetRate]);
 * typed result, never throws. Releases the record on EVERY failure branch (release symmetry).
 */
internal fun openMicAudioRecord(targetRate: Int, frameDurationMs: Int): Acquisition {
    val captureRate = resolveCaptureRate(targetRate)
    val minBuffer = AudioRecord.getMinBufferSize(captureRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) return Acquisition.Failed("min-buffer-$minBuffer")
    val frameSamples = (captureRate * frameDurationMs) / MS_PER_SECOND
    val bufferBytes = maxOf(minBuffer, frameSamples * BYTES_PER_PCM16_SAMPLE * BUFFER_SIZE_MULTIPLIER)
    val record = runCatching { buildRecord(captureRate, bufferBytes) }
        .getOrElse { e ->
            log.error("record-construct-failed", mapOf("cause" to (e.message ?: "unknown")))
            return Acquisition.Failed("construct-exception")
        }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        return Acquisition.Failed("init-state-${record.state}")
    }
    record.startRecording()
    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        record.release()
        return Acquisition.Failed("record-state-${record.recordingState}")
    }
    val resampler = if (captureRate == targetRate) null else Pcm16Resampler(captureRate, targetRate)
    log.info("session-open", mapOf("captureRate" to captureRate, "frameSamples" to frameSamples, "resampling" to (resampler != null)))
    return Acquisition.Ready(ReaderConfig(record, frameSamples, resampler))
}

@Suppress("MissingPermission") // guarded by hasRecordPermission() in AndroidMicSource.start()
private fun buildRecord(captureRate: Int, bufferBytes: Int): AudioRecord =
    AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        captureRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferBytes,
    )

/** Returns [targetRate] if the device accepts it, else the device fallback rate (resampled). */
private fun resolveCaptureRate(targetRate: Int): Int {
    val ok = AudioRecord.getMinBufferSize(targetRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (ok > 0) return targetRate
    log.warn("rate-fallback", mapOf("reason" to "native rate rejected", "fallbackRate" to FALLBACK_CAPTURE_RATE))
    return FALLBACK_CAPTURE_RATE
}
