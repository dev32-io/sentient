// ---------------------------------------------------------------------------
// AudioCaptureAdapter.android.kt — AudioRecord-backed mic capture (Android).
//
// Acquires AudioRecord with MediaRecorder.AudioSource.VOICE_COMMUNICATION, which
// routes through the platform's voice-processing path (HW/SW AEC + noise
// suppression on the uplink) — the Android analogue of iOS voice-processing IO.
// On top of that, AcousticEchoCanceler is attached to the capture session when
// AcousticEchoCanceler.isAvailable() reports true (logged; WARN when absent).
//
// Frames are PCM16 LE mono at [sampleRate] (16000). AudioRecord on modern
// hardware supports 16k mono natively; if getMinBufferSize() rejects the
// requested rate (ERROR_BAD_VALUE), capture falls back to the device default
// rate and DOWNSAMPLES to [sampleRate] with a linear resampler (logged).
//
// Lifecycle: start() acquires + startRecording(); frames(sampleRate) is a cold
// channelFlow that pumps fixed-duration PCM16 frames off a Dispatchers.IO reader
// loop until the collector cancels or stop() is called; stop() stops + releases.
//
// NO-CRASH CONTRACT (error-handling rule): a capture-start failure (missing
// RECORD_AUDIO permission, device busy, unsupported config) does NOT throw out
// of start() / the Flow — it logs WARN/ERROR and completes the frames Flow
// cleanly so the E3 pipeline can surface a failed-start without a process crash.
// RECORD_AUDIO is declared in the app manifest; the runtime prompt is the app's
// responsibility (E5/E6).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "capture", "android")

private const val DEFAULT_FRAME_DURATION_MS = 20
private const val MS_PER_SECOND = 1000
private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BUFFER_SIZE_MULTIPLIER = 4

/** Fallback capture rate when the hardware rejects the native 16k request. */
private const val FALLBACK_CAPTURE_RATE = 48_000

/**
 * Android [AudioCaptureAdapter] backed by [AudioRecord].
 *
 * The [Context] is read from [AndroidContextHolder] (set via
 * `MobileSdk.initAndroid(applicationContext)`). [frameDurationMs] is an operator
 * tunable that aligns the emitted frame size with the SpeechGate frame duration;
 * the E3 pipeline can inject the configured value, otherwise the 20ms default
 * applies.
 */
class AndroidAudioCaptureAdapter(
    private val frameDurationMs: Int = DEFAULT_FRAME_DURATION_MS,
    private val context: Context = AndroidContextHolder.requireContext(),
) : AudioCaptureAdapter {

    @Volatile
    private var session: CaptureSession? = null

    override suspend fun start(sampleRate: Int) {
        if (session != null) {
            log.debug("start-already-active", mapOf("sampleRate" to sampleRate))
            return
        }
        log.info("start", mapOf("sampleRate" to sampleRate, "frameDurationMs" to frameDurationMs))
        if (!hasRecordPermission()) {
            log.warn("start-no-permission", mapOf("reason" to "RECORD_AUDIO not granted"))
            return
        }
        session = runCatching { openSession(sampleRate) }
            .getOrElse { e ->
                log.error("start-failed", mapOf("reason" to "open", "cause" to (e.message ?: "unknown")))
                null
            }
    }

    override fun frames(sampleRate: Int): Flow<ByteArray> = channelFlow {
        val active = session
        if (active == null) {
            log.warn("frames-no-session", mapOf("reason" to "start() not called or failed"))
            return@channelFlow
        }
        var frameCount = 0L
        var byteCount = 0L
        val resampler = active.resampler(sampleRate)
        val readBuffer = ShortArray(active.captureFrameSamples)
        try {
            while (isActive) {
                val read = active.record.read(readBuffer, 0, readBuffer.size)
                if (read <= 0) {
                    log.warn("frames-read-nonpositive", mapOf("read" to read))
                    if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_DEAD_OBJECT) break
                    continue
                }
                val pcm = resampler.toPcm16Le(readBuffer, read)
                frameCount += 1
                byteCount += pcm.size
                trySend(pcm)
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            log.error("frames-loop-error", mapOf("cause" to (e.message ?: "unknown")))
        }
        log.info("frames-ended", mapOf("frames" to frameCount, "bytes" to byteCount))
        awaitClose { log.debug("frames-collector-closed") }
    }.flowOn(Dispatchers.IO)

    override suspend fun stop() {
        val active = session ?: run {
            log.debug("stop-noop")
            return
        }
        session = null
        log.info("stop")
        active.release()
    }

    // -----------------------------------------------------------------------
    // Session acquisition
    // -----------------------------------------------------------------------

    private fun openSession(targetRate: Int): CaptureSession {
        val captureRate = resolveCaptureRate(targetRate)
        val minBuffer = AudioRecord.getMinBufferSize(
            captureRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBuffer > 0) { "getMinBufferSize rejected rate=$captureRate (err=$minBuffer)" }

        val captureFrameSamples = (captureRate * frameDurationMs) / MS_PER_SECOND
        val bufferBytes = maxOf(minBuffer, captureFrameSamples * BYTES_PER_PCM16_SAMPLE * BUFFER_SIZE_MULTIPLIER)

        @Suppress("MissingPermission") // guarded by hasRecordPermission() in start()
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            captureRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            error("AudioRecord failed to initialise (state=${record.state}, rate=$captureRate)")
        }

        val aec = attachAec(record.audioSessionId)
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            aec?.release()
            record.release()
            error("AudioRecord failed to start recording (state=${record.recordingState})")
        }
        log.info(
            "session-open",
            mapOf("captureRate" to captureRate, "targetRate" to targetRate, "captureFrameSamples" to captureFrameSamples),
        )
        return CaptureSession(record, aec, captureRate, captureFrameSamples)
    }

    /** Returns [targetRate] if the device accepts it, else the device default rate. */
    private fun resolveCaptureRate(targetRate: Int): Int {
        val ok = AudioRecord.getMinBufferSize(targetRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (ok > 0) return targetRate
        log.warn(
            "rate-fallback",
            mapOf(
                "reason" to "getMinBufferSize rejected target",
                "targetRate" to targetRate,
                "fallbackRate" to FALLBACK_CAPTURE_RATE,
            ),
        )
        return FALLBACK_CAPTURE_RATE
    }

    /** Attaches platform AEC to [audioSessionId] when available; logs availability. */
    private fun attachAec(audioSessionId: Int): AcousticEchoCanceler? {
        if (!AcousticEchoCanceler.isAvailable()) {
            log.warn("aec-unavailable", mapOf("reason" to "AcousticEchoCanceler.isAvailable()=false"))
            return null
        }
        return runCatching {
            AcousticEchoCanceler.create(audioSessionId)?.also { it.enabled = true }
        }.getOrElse { e ->
            log.warn("aec-create-failed", mapOf("cause" to (e.message ?: "unknown")))
            null
        }?.also { log.info("aec-enabled", mapOf("enabled" to it.enabled)) }
    }

    private fun hasRecordPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
