// ---------------------------------------------------------------------------
// VoiceAudioRecord.android.kt — the AudioRecord half of [AndroidVoiceAudio].
//
// Split out of VoiceAudio.android.kt to stay under the 300-line file cap (S5b).
// Owns the reader-thread lifecycle: acquisition via [openMicAudioRecord] (see
// MicAudioRecordSession.android.kt), reader thread start/join, the read loop,
// frame emit + drop accounting, and the fatal-read notification. [trySend] and
// [onFatalRead] are injected — the mic channel and the [VoiceAudioState.Phase.Error]
// transition stay owned by [AndroidVoiceAudio] (mirrors [VoiceAudioPlayback]:
// the extracted half owns platform lifecycle, the parent owns cross-cutting state).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.io

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.os.Process
import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.Pcm16Resampler
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.concurrent.Volatile

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val FRAME_DURATION_MS = 20

// Reader-thread lifecycle (lifted from the prior Android mic adapter).
private const val READER_THREAD_NAME = "sentient-mic-reader"
private const val READER_JOIN_TIMEOUT_MS = 500L

// Per-frame trace throttle + dropped-frame WARN throttle (lifted).
private const val CAPTURE_TRACE_FIRST = 5
private const val CAPTURE_TRACE_EVERY = 25
private const val DROP_WARN_EVERY = 50

/**
 * The AudioRecord half of [AndroidVoiceAudio]: acquisition (via [openMicAudioRecord]) +
 * reader-thread lifecycle + frame emit/drop accounting. [trySend] pushes an emitted frame
 * onto [AndroidVoiceAudio]'s mic channel (returns success/failure); [onFatalRead] notifies
 * the parent to transition to [VoiceAudioState.Phase.Error] on a fatal mid-run read error.
 */
internal class VoiceAudioRecord(
    private val context: Context,
    private val trySend: (ShortArray) -> Boolean,
    private val onFatalRead: () -> Unit,
    private val meter: MicLevelMeter,
) {
    private val log = createLogger("voice", "engine", "android")

    @Volatile private var record: AudioRecord? = null
    @Volatile private var readerThread: Thread? = null
    @Volatile private var running = false
    @Volatile private var capturedCount = 0L
    @Volatile private var droppedCount = 0L
    @Volatile private var firstFrameSeen = false

    val captured: Long get() = capturedCount
    val dropped: Long get() = droppedCount

    /** Typed acquisition — never throws. Caller checks Ready/Failed → Phase.Error on Failed. */
    suspend fun start(source: Int): Acquisition {
        if (!hasRecordPermission()) return Acquisition.Failed("record-permission-denied")
        val result =
            withContext(Dispatchers.Default) {
                openMicAudioRecord(TARGET_SAMPLE_RATE_HZ, FRAME_DURATION_MS, source)
            }
        if (result is Acquisition.Ready) {
            running = true
            firstFrameSeen = false
            capturedCount = 0L
            droppedCount = 0L
            record = result.config.record
            startReaderThread(result.config)
            log.info(
                "record-started",
                mapOf("source" to source, "frameSamples" to result.config.frameSamples),
            )
        }
        return result
    }

    suspend fun stop() {
        running = false
        val r = record
        record = null
        val thread = readerThread
        readerThread = null
        if (r == null) {
            meter.reset()
            return
        }
        meter.reset()
        log.info("record-stop", mapOf("captured" to capturedCount, "dropped" to droppedCount))
        // record.stop() + thread.join() + record.release() all block — Dispatchers.IO
        // (canonical blocking-call dispatcher, NOT Default's CPU-bound pool).
        withContext(Dispatchers.IO) {
            runCatching { r.stop() } // unblocks the in-flight read()
                .onFailure { log.warn("stop-record-failed", mapOf("cause" to (it.message ?: "unknown"))) }
            joinReader(thread)
            runCatching { r.release() }
                .onFailure { log.warn("release-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        }
    }

    private fun startReaderThread(config: ReaderConfig) {
        val thread = Thread({ runReadLoop(config) }, READER_THREAD_NAME)
        thread.isDaemon = true
        readerThread = thread
        thread.start()
    }

    private fun runReadLoop(config: ReaderConfig) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val readBuffer = ShortArray(config.frameSamples)
        log.info("reader-start", mapOf("frameSamples" to config.frameSamples))
        while (running) {
            val read = config.record.read(readBuffer, 0, readBuffer.size)
            if (!running) break // stop() unblocked us — clean exit, not an error
            if (read <= 0) {
                if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_DEAD_OBJECT) {
                    handleFatalRead(read)
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
        // Metering is isolated from delivery: a visualization failure can never
        // backpressure or suppress the uplink frame.
        runCatching { meter.accept(frame) }
        val count = capturedCount
        val trace = count <= CAPTURE_TRACE_FIRST || count % CAPTURE_TRACE_EVERY == 0L
        if (trySend(frame)) {
            if (!firstFrameSeen) {
                firstFrameSeen = true
                log.info("mic-live", mapOf("samples" to frame.size))
            }
            if (trace) log.debug("frame-queued", mapOf("samples" to frame.size, "count" to count))
            return
        }
        droppedCount += 1
        if (droppedCount == 1L || droppedCount % DROP_WARN_EVERY == 0L) {
            log.warn(
                "frame-dropped",
                mapOf("reason" to "channel-full", "dropped" to droppedCount, "count" to count),
            )
        }
    }

    /**
     * Fatal mid-run read error → notifies [onFatalRead] so [AndroidVoiceAudio] can transition
     * to [VoiceAudioState.Phase.Error]. The mic channel is intentionally NOT closed here (it
     * lives across recovery): the caller recovers via configure(mic=false) → configure(mic=true)
     * which stops the dead record + starts a fresh reader thread on the SAME channel. Only
     * [AndroidVoiceAudio.shutdown] closes the channel.
     */
    private fun handleFatalRead(read: Int) {
        log.error("reader-fatal", mapOf("read" to read))
        running = false
        onFatalRead()
    }

    private fun joinReader(thread: Thread?) {
        if (thread == null) return
        runCatching { thread.join(READER_JOIN_TIMEOUT_MS) }
            .onFailure { log.warn("join-interrupted", mapOf("cause" to (it.message ?: "unknown"))) }
        if (thread.isAlive) {
            log.warn("reader-still-alive", mapOf("afterMs" to READER_JOIN_TIMEOUT_MS))
            thread.interrupt()
        }
    }

    private fun hasRecordPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}
