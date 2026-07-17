// ---------------------------------------------------------------------------
// VoiceAudio.android.kt — ONE AudioRecord + ONE AudioTrack serving every
// (mic, playback) state. The Android equivalent of the iOS one-engine actual:
// the two platform objects are independent (no shared-session fragility), so
// configure() opens/closes each per the [voiceAudioGraph] matrix.
//
// HW AEC source (VOICE_COMMUNICATION) is enabled EXACTLY in the mic+playback
// cell (the VPIO-equivalent) on the Duplex path; mic-only cells use VOICE_RECOGNITION
// (no echo to cancel, no platform AEC/NS double-processing). The Manual path (Hold)
// always uses VOICE_RECOGNITION — mic and playback never overlap in Hold, so no AEC
// is ever needed (S5; see [recordSource]). Playback's AudioAttributes usage also
// switches by path (USAGE_ASSISTANT for Manual vs USAGE_VOICE_COMMUNICATION for
// Duplex, unchanged) — see VoiceAudioPlayback.android.kt.
// PROVEN SNIPPETS (assembled from the retired two-engine audio path; sources live
// in git history):
//   - Record acquisition + read loop + drop-newest channel + soft-fail →
//     the prior Android mic adapter + MicAudioRecordSession.android.kt.
//   - Playback track build + non-blocking write + drop-oldest overflow ring +
//     head-position idle check → the prior Android playback adapter (extracted to
//     VoiceAudioPlayback.android.kt to keep this file under the 300-line cap).
// NO-CRASH CONTRACT (T4): every open/start failure → Phase.Error(reason) + return
// BEFORE current = desired. Typed returns — never throws. Logs lengths/counts/ids
// ONLY (PrivacyGuard). DEVICE-VERIFIED (sim has no mic); compile GREEN is the agent
// gate, device mic run is user-owned.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.io

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import io.sentient.mobilesdk.AndroidContextHolder
import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.Pcm16Resampler
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.withContext
import kotlin.concurrent.Volatile

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val FRAME_DURATION_MS = 20

// Bounded SUSPEND frames channel: trySend on a FULL buffer fails → newest frame
// dropped + counted (drop-NEWEST, NOT DROP_OLDEST). Tuned constant — copy exact.
private const val FRAME_CHANNEL_CAPACITY = 16

// Reader-thread lifecycle (lifted from the prior Android mic adapter).
private const val READER_THREAD_NAME = "sentient-mic-reader"
private const val READER_JOIN_TIMEOUT_MS = 500L

// Per-frame trace throttle + dropped-frame WARN throttle (lifted).
private const val CAPTURE_TRACE_FIRST = 5
private const val CAPTURE_TRACE_EVERY = 25
private const val DROP_WARN_EVERY = 50

/**
 * ONE [AudioRecord] + ONE [AudioTrack] serving every (mic, playback) state.
 *
 * [configure] diffs [voiceAudioGraph] against the last-applied graph and opens /
 * closes each platform object per the matrix. Idempotent (no-op if already in the
 * requested state). Never throws — failures become [Phase.Error].
 */
class AndroidVoiceAudio(
    private val context: Context = AndroidContextHolder.requireContext(),
) : VoiceAudio {
    private val log = createLogger("voice", "engine", "android")

    private val _state =
        MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    // Bounded SUSPEND channel; drop-newest via trySend (mirrors the prior Android mic adapter).
    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()

    // The currently-applied graph; configure diffs against this.
    private var current: VoiceAudioGraph = voiceAudioGraph(mic = false, playback = false)

    // The currently-applied routing hint, paired with [current]. [voiceAudioGraph] alone
    // can't see this axis, so a path flip on an otherwise-unchanged (mic, playback) cell
    // (e.g. lockMic(): Hold's MicCapture (T,F,Manual) → Continuous' mic-only Duplex cell
    // (T,F,Duplex)) must still drive a real stop+rebuild of the affected component(s),
    // never a silent no-op (S5).
    private var currentPath: VoiceAudioPath = VoiceAudioPath.Duplex

    // The AudioTrack half — extracted to VoiceAudioPlayback.android.kt.
    private val playback = VoiceAudioPlayback()

    // --- Record state (lifted from the prior Android mic adapter) ---
    @Volatile private var record: AudioRecord? = null
    @Volatile private var readerThread: Thread? = null
    @Volatile private var running = false
    @Volatile private var capturedCount = 0L
    @Volatile private var droppedCount = 0L
    @Volatile private var firstFrameSeen = false

    /** Legacy 3-arg entry point — delegates with [VoiceAudioPath.Duplex] (unchanged behavior). */
    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) =
        configure(mic, playback, VoiceAudioPath.Duplex, playbackRateHz)

    override suspend fun configure(mic: Boolean, playback: Boolean, path: VoiceAudioPath, playbackRateHz: Int) {
        val desired = voiceAudioGraph(mic, playback)
        val pathChanged = path != currentPath
        if (desired == current && !pathChanged) {
            log.debug("configure-noop", mapOf("mic" to mic, "playback" to playback, "path" to path.name))
            return
        }
        log.info(
            "configure",
            mapOf(
                "mic" to mic,
                "playback" to playback,
                "path" to path.name,
                "aec" to desired.vpio,
                "rate" to playbackRateHz,
            ),
        )
        _state.value = _state.value.copy(phase = Phase.Configuring, micActive = mic, playbackActive = playback)

        // A component "changes" when its ON/OFF bool flips, OR (staying on) a path flip
        // means its source/attrs may now differ — either way it must stop + rebuild.
        val inputRebuild = desired.inputTap && current.inputTap && pathChanged
        val playerRebuild = desired.player && current.player && pathChanged
        val inputChanged = desired.inputTap != current.inputTap || inputRebuild
        val playerChanged = desired.player != current.player || playerRebuild

        // Stop components turning OFF (or rebuilding) first (free resources before alloc).
        if (inputChanged && (!desired.inputTap || inputRebuild)) stopRecord()
        if (playerChanged && (!desired.player || playerRebuild)) this.playback.stop()

        // Start components turning ON (or rebuilding). On failure startComponents sets
        // Phase.Error via failConfigure + returns false BEFORE current/currentPath = desired
        // (T4 — no silent Ready).
        if (!startComponents(desired, path, inputChanged, playerChanged, playbackRateHz)) return

        current = desired
        currentPath = path
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    /** Starts ON-components (incl. rebuilds); returns false (after [failConfigure] → [Phase.Error]) on any failure. */
    private suspend fun startComponents(
        desired: VoiceAudioGraph,
        path: VoiceAudioPath,
        inputChanged: Boolean,
        playerChanged: Boolean,
        playbackRateHz: Int,
    ): Boolean {
        if (inputChanged && desired.inputTap) {
            val source = recordSource(path, desired)
            when (val r = startRecord(source)) {
                is Acquisition.Ready -> Unit
                is Acquisition.Failed -> {
                    failConfigure(desired.inputTap, desired.player, "record", r.reason)
                    return false
                }
            }
        }
        if (playerChanged && desired.player) {
            if (!this.playback.start(playbackRateHz, path)) {
                // failConfigure tears down BOTH objects (incl. the just-started record).
                failConfigure(desired.inputTap, desired.player, "track", "track-build-failed")
                return false
            }
        }
        return true
    }

    /**
     * Record source by (path, cell). Duplex keeps the existing AEC rule: VOICE_COMMUNICATION
     * exactly in the mic+playback cell, else VOICE_RECOGNITION. Manual never needs platform
     * AEC — mic and playback never overlap in Hold — so it is always VOICE_RECOGNITION.
     * (T,T,Manual) is unreachable from TalkModeController; if it arrives anyway, WARN + fall
     * back to the Duplex rule rather than silently routing a genuine echo cell through a
     * no-AEC source (defensive).
     */
    private fun recordSource(path: VoiceAudioPath, desired: VoiceAudioGraph): Int =
        when {
            path == VoiceAudioPath.Manual && desired.vpio -> {
                log.warn(
                    "manual-path-aec-cell",
                    mapOf("reason" to "unreachable (mic+playback, Manual) — falling back to Duplex source rule"),
                )
                MediaRecorder.AudioSource.VOICE_COMMUNICATION
            }
            path == VoiceAudioPath.Manual -> MediaRecorder.AudioSource.VOICE_RECOGNITION
            desired.vpio -> MediaRecorder.AudioSource.VOICE_COMMUNICATION
            else -> MediaRecorder.AudioSource.VOICE_RECOGNITION
        }

    /**
     * A configure failure. Partial-failure state desync fix: the OFF-components were
     * already stopped (before startComponents) and startComponents rolls back its own
     * record start, but [current] still points at the OLD graph — so the next configure
     * would diff against a graph that no longer matches the (now torn-down) engine and
     * re-open/re-close the wrong objects. Hard-reset both objects + [current] to a clean
     * idle baseline so the next configure rebuilds from scratch.
     */
    private suspend fun failConfigure(mic: Boolean, playback: Boolean, step: String, reason: String) {
        stopRecord()
        this.playback.stop()
        current = voiceAudioGraph(mic = false, playback = false)
        currentPath = VoiceAudioPath.Duplex
        _state.value =
            VoiceAudioState(Phase.Error, micActive = mic, playbackActive = playback, errorReason = reason)
        log.warn("configure-failed", mapOf("step" to step, "reason" to reason))
    }

    // --- Record (openMicAudioRecord + read loop lifted from the prior Android mic adapter) ---

    /** Typed acquisition — never throws. Caller checks Ready/Failed → Phase.Error on Failed. */
    private suspend fun startRecord(source: Int): Acquisition {
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

    private suspend fun stopRecord() {
        running = false
        val r = record
        record = null
        val thread = readerThread
        readerThread = null
        if (r == null) return
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
        if (micCh.trySend(frame).isSuccess) {
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
     * Fatal mid-run read error → [Phase.Error]. The mic channel is intentionally NOT
     * closed (it lives across recovery): the caller recovers via configure(mic=false)
     * → configure(mic=true) which stops the dead record + starts a fresh reader thread
     * on the SAME channel. Only [shutdown] closes [micCh].
     */
    private fun onFatalRead(read: Int) {
        log.error("reader-fatal", mapOf("read" to read))
        running = false
        _state.value =
            VoiceAudioState(
                Phase.Error,
                micActive = current.inputTap,
                playbackActive = current.player,
                errorReason = "read-error",
            )
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

    // --- VoiceAudio surface (playback delegates to [playback]) ---

    override fun playFrame(pcm16: ByteArray) {
        if (!current.player) return
        playback.enqueue(pcm16)
    }

    override fun flushPlayback() = playback.clear()

    override val isPlaybackIdle: Boolean get() = playback.isIdle

    override suspend fun shutdown() {
        log.info("shutdown", mapOf("captured" to capturedCount, "dropped" to droppedCount))
        stopRecord()
        playback.stop()
        micCh.close()
        current = voiceAudioGraph(mic = false, playback = false)
        currentPath = VoiceAudioPath.Duplex
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
    }
}
