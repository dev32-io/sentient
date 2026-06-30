// ---------------------------------------------------------------------------
// AndroidMicSource.kt — voice-pipeline mic primitive (Android), AudioRecord path.
//
// MIRRORS the proven AudioRecord acquisition from AndroidAudioCaptureAdapter
// (VOICE_COMMUNICATION source, getMinBufferSize sizing, STATE_INITIALIZED /
// RECORDSTATE_RECORDING checks, 16k-native with device-rate + Pcm16Resampler
// fallback) with the Task-7 refactor's behavioral changes:
//  1. NO stacked AEC/NS/AGC — VOICE_COMMUNICATION already provides platform AEC+NS;
//     stacking double-processes (attachAec() is deliberately NOT carried over).
//  2. frames is Flow<ShortArray>: 16k native → copyOf(read) (no codec); fallback →
//     resampler.toPcm16Le(...) → pcm16LeToShorts(...).
//  3. Dedicated realtime Thread at THREAD_PRIORITY_URGENT_AUDIO (NOT Dispatchers.IO).
//  4. Bounded SUSPEND channel + drop-NEWEST (NOT DROP_OLDEST / DROP_LATEST).
//  5. StateFlow<MicState>: Idle → Initializing → Live (first frame) → Error/Idle.
//  6. RE-STARTABLE: each start() mints a FRESH channel; stop() clears the latch.
//
// NO-CRASH CONTRACT: every failure fails SOFT → MicState.Error + close channel.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.io

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.Pcm16Resampler
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.MicState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.withContext
import kotlin.concurrent.Volatile

private val log = createLogger("voice", "mic", "android")

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val FALLBACK_CAPTURE_RATE = 48_000 // device rate when the hardware rejects 16k
private const val FRAME_DURATION_MS = 20
private const val MS_PER_SECOND = 1000
private const val BYTES_PER_PCM16_SAMPLE = 2
private const val BUFFER_SIZE_MULTIPLIER = 4

// Bounded SUSPEND frames channel: trySend on a FULL buffer fails → newest frame dropped +
// counted. Small — a backlog past this many ~20ms frames means downstream stalled.
private const val FRAME_CHANNEL_CAPACITY = 16

// Per-frame trace throttle (first N + every Nth) + dropped-frame WARN throttle.
private const val CAPTURE_TRACE_FIRST = 5
private const val CAPTURE_TRACE_EVERY = 25
private const val DROP_WARN_EVERY = 50

private const val READER_THREAD_NAME = "sentient-mic-reader"
private const val READER_JOIN_TIMEOUT_MS = 500L

/**
 * Android [MicSource] backed by [AudioRecord] on a dedicated realtime thread.
 *
 * Re-startable: the SDK holds ONE instance and toggles start()/stop() repeatedly. Each
 * start() mints a FRESH frames channel ([resetSession]) + resets counters/latch; stop()
 * clears the latch + closes the old channel and reacquires AudioRecord on the next start().
 * [frames] is a getter over the CURRENT channel; the pipeline calls start() (→ fresh channel)
 * BEFORE it collects. The blocking read() loop runs on a dedicated [Thread] at
 * THREAD_PRIORITY_URGENT_AUDIO — never on the orchestrator coroutine. The orchestrator drives
 * start()/stop() SERIALLY, so AudioRecord is never mutated concurrently and no reader leaks.
 * A fatal mid-run read error ([onFatalRead]) surfaces Error + closes the channel; recovery is
 * a stop()/start() cycle (the FSM's normal response to Error).
 */
class AndroidMicSource(
    private val context: Context = AndroidContextHolder.requireContext(),
) : MicSource {

    // Default single-arg Channel = BufferOverflow.SUSPEND → trySend fails when full (the
    // drop-newest contract). NOT DROP_OLDEST / DROP_LATEST. Recreated FRESH per start();
    // frames is a getter over the CURRENT channel.
    @Volatile private var currentChannel = Channel<ShortArray>(FRAME_CHANNEL_CAPACITY)
    override val frames: Flow<ShortArray> get() = currentChannel.receiveAsFlow()

    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    override val state: StateFlow<MicState> = _state.asStateFlow()

    @Volatile private var started = false
    @Volatile private var running = false
    @Volatile private var active: ReaderConfig? = null
    @Volatile private var readerThread: Thread? = null
    @Volatile private var firstFrameSeen = false
    @Volatile private var capturedCount = 0L
    @Volatile private var droppedCount = 0L

    override suspend fun start() {
        if (started) {
            log.debug("start-already")
            return
        }
        started = true
        resetSession()
        log.info("start", mapOf("targetRate" to TARGET_SAMPLE_RATE_HZ))
        _state.value = MicState.Initializing
        if (!hasRecordPermission()) {
            failSoft("record-permission-denied")
            return
        }
        when (val result = withContext(Dispatchers.Default) { openSession() }) {
            is Acquisition.Ready -> {
                active = result.config
                startReaderThread(result.config)
                log.info("started")
            }
            is Acquisition.Failed -> failSoft(result.reason)
        }
    }

    /** Fresh per-session state so the single instance is re-startable across start/stop/start. */
    private fun resetSession() {
        currentChannel = Channel(FRAME_CHANNEL_CAPACITY)
        firstFrameSeen = false
        capturedCount = 0L
        droppedCount = 0L
    }

    override suspend fun stop() {
        started = false // clear the latch so the NEXT start() reacquires AudioRecord
        val config = active
        active = null
        val thread = readerThread
        readerThread = null
        if (config == null) {
            log.debug("stop-noop")
            currentChannel.close()
            _state.value = MicState.Idle
            return
        }
        log.info("stop", mapOf("captured" to capturedCount, "dropped" to droppedCount))
        running = false // signal the read loop to exit
        withContext(Dispatchers.Default) {
            runCatching { config.record.stop() } // unblocks the in-flight read()
                .onFailure { log.warn("stop-record-failed", mapOf("cause" to (it.message ?: "unknown"))) }
            joinReader(thread)
            runCatching { config.record.release() }
                .onFailure { log.warn("release-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        }
        currentChannel.close()
        _state.value = MicState.Idle
    }

    // --- Acquisition (runs on Dispatchers.Default, off the main thread) ---

    /** Acquires AudioRecord (16k-native or device-rate fallback); typed result, never throws. */
    private fun openSession(): Acquisition {
        val captureRate = resolveCaptureRate()
        val minBuffer = AudioRecord.getMinBufferSize(captureRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer <= 0) return Acquisition.Failed("min-buffer-$minBuffer")
        val frameSamples = (captureRate * FRAME_DURATION_MS) / MS_PER_SECOND
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
        val resampler = if (captureRate == TARGET_SAMPLE_RATE_HZ) null else Pcm16Resampler(captureRate, TARGET_SAMPLE_RATE_HZ)
        log.info("session-open", mapOf("captureRate" to captureRate, "frameSamples" to frameSamples, "resampling" to (resampler != null)))
        return Acquisition.Ready(ReaderConfig(record, frameSamples, resampler))
    }

    @Suppress("MissingPermission") // guarded by hasRecordPermission() in start()
    private fun buildRecord(captureRate: Int, bufferBytes: Int): AudioRecord =
        AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            captureRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )

    /** Returns 16k if the device accepts it, else the device fallback rate (resampled). */
    private fun resolveCaptureRate(): Int {
        val ok = AudioRecord.getMinBufferSize(TARGET_SAMPLE_RATE_HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (ok > 0) return TARGET_SAMPLE_RATE_HZ
        log.warn("rate-fallback", mapOf("reason" to "16k rejected", "fallbackRate" to FALLBACK_CAPTURE_RATE))
        return FALLBACK_CAPTURE_RATE
    }

    // --- Reader thread (blocking read loop — trySend only, no coroutines) ---

    private fun startReaderThread(config: ReaderConfig) {
        running = true
        val thread = Thread({ runReadLoop(config) }, READER_THREAD_NAME)
        thread.isDaemon = true
        readerThread = thread
        thread.start()
    }

    private fun runReadLoop(config: ReaderConfig) {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
        val readBuffer = ShortArray(config.frameSamples)
        log.info("reader-start", mapOf("frameSamples" to config.frameSamples))
        while (running) {
            val read = config.record.read(readBuffer, 0, readBuffer.size)
            if (!running) break // stop() unblocked us — clean exit, not an error
            if (read <= 0) {
                if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_DEAD_OBJECT) {
                    onFatalRead(read)
                    break
                }
                log.warn("read-nonpositive", mapOf("read" to read))
                continue
            }
            capturedCount += 1
            emitFrame(toFrame(readBuffer, read, config.resampler))
        }
        log.info("reader-ended", mapOf("captured" to capturedCount, "dropped" to droppedCount))
    }

    /** 16k native → COPY of the read samples (no codec). Fallback → resample → LE → shorts. */
    private fun toFrame(buffer: ShortArray, read: Int, resampler: Pcm16Resampler?): ShortArray =
        if (resampler == null) buffer.copyOf(read) else pcm16LeToShorts(resampler.toPcm16Le(buffer, read))

    /** trySend the frame; on a full buffer drop the NEWEST + count it (throttled WARN). */
    private fun emitFrame(frame: ShortArray) {
        val count = capturedCount
        val trace = count <= CAPTURE_TRACE_FIRST || count % CAPTURE_TRACE_EVERY == 0L
        if (currentChannel.trySend(frame).isSuccess) {
            if (!firstFrameSeen) markLive(frame.size)
            if (trace) log.debug("frame-queued", mapOf("samples" to frame.size, "count" to count))
            return
        }
        droppedCount += 1
        if (droppedCount == 1L || droppedCount % DROP_WARN_EVERY == 0L) {
            log.warn("frame-dropped", mapOf("reason" to "channel-full", "dropped" to droppedCount, "count" to count))
        }
    }

    /** First delivered frame → MicState.Live (StateFlow is thread-safe; reader-thread set is fine). */
    private fun markLive(samples: Int) {
        firstFrameSeen = true
        _state.value = MicState.Live
        log.info("mic-live", mapOf("samples" to samples))
    }

    /** Fatal mid-run read error → surface Error + close channel; recovery is stop()/start(). */
    private fun onFatalRead(read: Int) {
        log.error("reader-fatal", mapOf("read" to read))
        running = false
        _state.value = MicState.Error("read-error")
        currentChannel.close()
    }

    // --- Helpers ---

    private fun joinReader(thread: Thread?) {
        if (thread == null) return
        runCatching { thread.join(READER_JOIN_TIMEOUT_MS) }
            .onFailure { log.warn("join-interrupted", mapOf("cause" to (it.message ?: "unknown"))) }
        if (thread.isAlive) {
            log.warn("reader-still-alive", mapOf("afterMs" to READER_JOIN_TIMEOUT_MS))
            thread.interrupt()
        }
    }

    /** Terminal soft fail: MicState.Error + close channel + clear the started latch (retryable). */
    private fun failSoft(reason: String) {
        log.warn("start-failed", mapOf("reason" to reason))
        started = false
        _state.value = MicState.Error(reason)
        currentChannel.close()
    }

    private fun hasRecordPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** One acquired AudioRecord run: live record + read sizing + (fallback) resampler. */
    private class ReaderConfig(val record: AudioRecord, val frameSamples: Int, val resampler: Pcm16Resampler?)

    /** Typed acquisition outcome — never throws across the start() boundary. */
    private sealed interface Acquisition {
        data class Ready(val config: ReaderConfig) : Acquisition
        data class Failed(val reason: String) : Acquisition
    }
}
