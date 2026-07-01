// ---------------------------------------------------------------------------
// IosMicSource.kt — voice-pipeline mic primitive (iOS), convert-in-tap path.
//
// The Task-7 refactor's iOS [MicSource]. It MIRRORS the proven, device-verified
// capture sequence from IosAudioCaptureAdapter (aa44502): obtain the shared
// full-duplex engine via SharedAudioEngine.retainForCapture(), validate the input
// format BEFORE any throwing AV call, build a reused Pcm16Converter (48k→16k), install
// an input tap, and ensureRunning(). The tap callback runs the converter DIRECTLY on
// the render thread (proven OK) — no ring + consumer hop.
//
// FOUR behavioral differences from the old adapter (the refactor's point):
//  1. frames is Flow<ShortArray>, not ByteArray. The tap converts the PCM16 LE bytes
//     to ShortArray (pcm16LeToShorts) before handing them downstream.
//  2. Backpressure is a bounded SUSPEND channel + DROP-NEWEST: trySend into a small
//     Channel<ShortArray>; on a full buffer trySend fails and the NEWEST frame is
//     dropped + counted (throttled WARN). NOT DROP_OLDEST (the old adapter's bug) and
//     NOT DROP_LATEST (silent).
//  3. state is a StateFlow<MicState> for the UI: Idle → Initializing (start) → Live
//     (first delivered frame, set from the render thread) → Error(reason) on any
//     failure → Idle (stop).
//  4. start() runs the AV setup OFF the main thread (withContext(setupDispatcher)). Tap
//     install (start) + removal (stop) are render-graph mutations; they are safe NOT from
//     sharing a thread (setupDispatcher = Dispatchers.Default is a POOL — "same dispatcher"
//     is NOT "same thread") but because the SDK drives start()/stop() SERIALLY on the
//     orchestrator coroutine, so the graph is never mutated concurrently (SharedAudioEngine).
//
// OUTPUT GRAPH (always) vs VP (currently off) — two SEPARATE things:
//  • We ALWAYS reference mainMixerNode to establish mainMixer→outputNode. That output half of
//    the graph is what E2 playback needs: it attaches its player to this SAME shared engine +
//    mixer, and WITHOUT the output graph the player start()s "in a disconnected state" → crash
//    + silent TTS. This is the real full-duplex-playback fix and does NOT need VP.
//  • VP (voice-processing IO = AEC+NS+AGC) is CURRENTLY OFF. It would cancel the TTS echo from
//    the uplink, but VPIO has stricter session requirements that broke mic-start on the
//    .playback→.playAndRecord handoff after TTS (AUIOClient_StartIO failed), so it is disabled.
//    Echo (mic hearing TTS) is a separate concern handled later without VPIO.
//
// NO-CRASH CONTRACT (error-handling rule): every failure path fails SOFT — sets
// MicState.Error + closes the frames channel — never throws across the @ObjCExport
// boundary (K/N traps a thrown Throwable as SIGABRT). The input-format guard
// short-circuits BEFORE the throwing AV calls (installTapOnBus raises an NSException on
// a zero format that runCatching cannot catch); SharedAudioEngine's ObjC @try/@catch
// guards the engine prepare/start. A real device reports a valid format → capture runs.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.Pcm16Converter
import io.sentient.mobilesdk.audioio.SharedAudioEngine
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.MicState
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.withContext
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioInputNode
import platform.AVFAudio.AVAudioPCMBuffer
import platform.Foundation.NSError
import kotlin.concurrent.Volatile
import kotlin.coroutines.cancellation.CancellationException

private val log = createLogger("voice", "mic", "ios")

private const val INPUT_BUS = 0uL
private const val OUTPUT_BUS = 0uL
private const val TAP_BUFFER_FRAMES = 1024u
private const val TARGET_SAMPLE_RATE_HZ = 16_000

// Voice processing (AEC+NS+AGC) on the shared capture engine. OFF: VPIO regressed mic-start on
// the .playback→.playAndRecord handoff after TTS (AUIOClient_StartIO failed) and is NOT needed
// for the crash fix (the mainMixerNode output-graph reference below handles that independently).
// VP only buys echo cancellation — deferred, to be solved without VPIO. Do NOT flip to true
// without also resolving the post-TTS session-handoff StartIO failure.
private const val ENABLE_CAPTURE_VOICE_PROCESSING = false

// Bounded SUSPEND frames channel. trySend on a FULL buffer fails → the newest frame is
// dropped (drop-newest) + counted. Small: the consumer (uplink pipeline) drains in real
// time; a backlog past this many 20ms frames means downstream stalled, drop is correct.
private const val FRAME_CHANNEL_CAPACITY = 16

// Tap-buffer trace throttle: first N buffers + every Nth after (keeps the uplink trace
// visible without flooding the vitals ring at ~10 buffers/sec). Mirrors the old adapter.
private const val CAPTURE_TRACE_FIRST = 5
private const val CAPTURE_TRACE_EVERY = 25

// Dropped-frame WARN throttle: warn on the first drop + every Nth after.
private const val DROP_WARN_EVERY = 50

/**
 * iOS [MicSource] backed by the shared full-duplex [AVAudioEngine].
 *
 * Re-startable: the SDK holds ONE instance and toggles start()/stop() repeatedly. Each
 * start() mints a FRESH frames channel (see [resetSession]) and resets the latch/counters;
 * stop() clears the latch + closes the (now-old) channel — so no frames leak across sessions
 * and the 2nd start() is not blocked by the [started] guard. [frames] is a getter over the
 * CURRENT channel; the pipeline calls start() (→ fresh channel) BEFORE it reads frames. The
 * AV setup runs on [setupDispatcher] (default [Dispatchers.Default]) so the main thread is
 * never blocked. The tap callback runs on the audio render thread; non-blocking convert +
 * trySend only.
 */
class IosMicSource(
    private val setupDispatcher: CoroutineDispatcher = Dispatchers.Default,
) : MicSource {

    private val shared = SharedAudioEngine.instance

    // Default single-arg Channel = BufferOverflow.SUSPEND → trySend fails when full (the
    // drop-newest contract). Do NOT pass DROP_OLDEST (silent old-frame eviction) / DROP_LATEST.
    // Recreated FRESH per start() (resetSession) so one instance is re-startable; frames is a
    // getter over the CURRENT channel (pipeline calls start() before reading frames).
    @Volatile
    private var currentChannel = Channel<ShortArray>(FRAME_CHANNEL_CAPACITY)
    override val frames: Flow<ShortArray> get() = currentChannel.receiveAsFlow()

    private val _state = MutableStateFlow<MicState>(MicState.Idle)
    override val state: StateFlow<MicState> = _state.asStateFlow()

    @Volatile
    private var engine: AVAudioEngine? = null

    @Volatile
    private var started = false

    @Volatile
    private var tapFiredOnce = false

    // Reset in resetSession() (before the tap installs), then mutated serially in the tap —
    // no @Volatile needed (the reset happens-before tap callbacks via the engine-start path).
    private var capturedCount = 0
    private var droppedCount = 0

    override suspend fun start() {
        if (started) {
            log.debug("start-already")
            return
        }
        started = true
        resetSession()
        log.info("start", mapOf("targetRate" to TARGET_SAMPLE_RATE_HZ))
        _state.value = MicState.Initializing
        val ok = withContext(setupDispatcher) {
            runCatching { startEngine() }.getOrElse { e ->
                if (e is CancellationException) throw e // structured concurrency — never swallow
                // A throw AFTER retainForCapture() leaves the capture retain held; release it
                // (releaseForCapture is noop-safe when none) so the refcount stays consistent.
                log.error("start-exception", mapOf("cause" to (e.message ?: "unknown")))
                releaseAndFail("setup-exception")
            }
        }
        if (ok) log.info("started")
    }

    /** Fresh per-session state so the single instance is re-startable across start/stop/start. */
    private fun resetSession() {
        currentChannel = Channel(FRAME_CHANNEL_CAPACITY)
        tapFiredOnce = false
        capturedCount = 0
        droppedCount = 0
    }

    override suspend fun stop() {
        started = false // clear the latch so the NEXT start() is not no-op'd
        val active = engine
        engine = null
        if (active == null) {
            log.debug("stop-noop")
            currentChannel.close()
            _state.value = MicState.Idle
            return
        }
        log.info("stop", mapOf("captured" to capturedCount, "dropped" to droppedCount))
        withContext(setupDispatcher) {
            runCatching { active.inputNode.removeTapOnBus(INPUT_BUS) }
                .onFailure { log.warn("stop-teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
            shared.releaseForCapture()
        }
        currentChannel.close()
        _state.value = MicState.Idle
    }

    // -----------------------------------------------------------------------
    // Engine setup (runs on setupDispatcher, off the main thread)
    // -----------------------------------------------------------------------

    /**
     * Acquires the shared engine + installs the tap; returns false on any failure (no
     * throw). Each internal failure path releases the capture retain so the refcount stays
     * consistent. The input-format guard short-circuits BEFORE the throwing AV calls.
     */
    private fun startEngine(): Boolean {
        val avEngine = shared.retainForCapture() ?: return failSoft("engine-null")
        val input: AVAudioInputNode = avEngine.inputNode

        // Guard the PRE-VP format before any throwing AV call (a zero format → NSException that
        // runCatching cannot catch). Enabling VP below CHANGES the format; re-read it after.
        val preVpFormat = input.inputFormatForBus(INPUT_BUS)
        if (!isValidInputFormat(preVpFormat)) {
            log.warn("mic-unavailable", mapOf("inputRate" to preVpFormat.sampleRate, "channels" to preVpFormat.channelCount.toLong()))
            return releaseAndFail("invalid-input-format")
        }
        if (ENABLE_CAPTURE_VOICE_PROCESSING) enableVoiceProcessing(input)
        val inputFormat = input.inputFormatForBus(INPUT_BUS)
        if (!isValidInputFormat(inputFormat)) return releaseAndFail("invalid-post-vp-format")

        val converter = Pcm16Converter(inputFormat, TARGET_SAMPLE_RATE_HZ)
        if (!converter.isReady) return releaseAndFail("converter-init")
        input.installTapOnBus(INPUT_BUS, bufferSize = TAP_BUFFER_FRAMES, format = inputFormat) { buffer, _ ->
            forwardBuffer(buffer, converter)
        }
        // Establish the OUTPUT graph (mainMixer→outputNode) BEFORE start — ALWAYS, independent of
        // VP. E2 playback attaches its player to this SAME mixer; without the output half of the
        // graph the player start()s "in a disconnected state" (crash + silent TTS). Renders silence
        // until playback connects its player.
        val outputMixer = avEngine.mainMixerNode
        log.debug("output-graph-ensured", mapOf("outputRate" to outputMixer.outputFormatForBus(OUTPUT_BUS).sampleRate))
        if (!shared.ensureRunning()) {
            input.removeTapOnBus(INPUT_BUS)
            return releaseAndFail("engine-start")
        }
        engine = avEngine
        log.info("session-open", mapOf("inputRate" to inputFormat.sampleRate, "targetRate" to TARGET_SAMPLE_RATE_HZ, "vp" to ENABLE_CAPTURE_VOICE_PROCESSING))
        return true
    }

    /**
     * True when [format] describes a usable mic route. A simulator with no real mic (or a
     * device with no input route) reports a zero format; feeding that to installTapOnBus
     * raises an ObjC NSException that runCatching cannot catch (→ SIGABRT).
     */
    private fun isValidInputFormat(format: AVAudioFormat): Boolean =
        format.sampleRate > 0.0 && format.channelCount > 0u

    /** Enables the voice-processing IO unit (AEC+NS+AGC) on [input]; logs availability (non-fatal). */
    private fun enableVoiceProcessing(input: AVAudioInputNode) {
        val enabled = memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
            val ok = input.setVoiceProcessingEnabled(true, errVar.ptr)
            if (!ok) log.warn("voice-processing-unavailable", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            ok
        }
        log.info("voice-processing", mapOf("enabled" to enabled))
    }

    // -----------------------------------------------------------------------
    // Tap callback (runs on the audio render thread — convert + trySend only)
    // -----------------------------------------------------------------------

    /** Converts one tap buffer to a 16k PCM16 ShortArray frame and delivers it (audio-thread safe). */
    private fun forwardBuffer(buffer: AVAudioPCMBuffer?, converter: Pcm16Converter) {
        if (buffer == null) return
        capturedCount += 1
        val trace = capturedCount <= CAPTURE_TRACE_FIRST || capturedCount % CAPTURE_TRACE_EVERY == 0
        if (trace) log.debug("tap-buffer", mapOf("frames" to buffer.frameLength.toLong(), "count" to capturedCount))
        val bytes = converter.convert(buffer)
        if (bytes == null) {
            if (trace) log.debug("tap-frame-dropped", mapOf("reason" to "convert-null", "count" to capturedCount))
            return
        }
        deliver(pcm16LeToShorts(bytes), trace)
    }

    /** trySend the frame; on a full buffer drop the NEWEST + count it (throttled WARN). */
    private fun deliver(shorts: ShortArray, trace: Boolean) {
        if (currentChannel.trySend(shorts).isSuccess) {
            if (!tapFiredOnce) markLive(shorts.size)
            if (trace) log.debug("tap-frame-queued", mapOf("samples" to shorts.size, "count" to capturedCount))
            return
        }
        droppedCount += 1
        if (droppedCount == 1 || droppedCount % DROP_WARN_EVERY == 0) {
            log.warn("frame-dropped", mapOf("reason" to "channel-full", "dropped" to droppedCount, "count" to capturedCount))
        }
    }

    /** First delivered frame → MicState.Live (StateFlow is thread-safe; render-thread set is fine). */
    private fun markLive(samples: Int) {
        tapFiredOnce = true
        _state.value = MicState.Live
        log.info("mic-live", mapOf("samples" to samples))
    }

    // -----------------------------------------------------------------------
    // Soft-fail helpers
    // -----------------------------------------------------------------------

    /** Releases the shared-engine capture retain, then soft-fails with [reason]. */
    private fun releaseAndFail(reason: String): Boolean {
        shared.releaseForCapture()
        return failSoft(reason)
    }

    /**
     * Terminal soft fail: MicState.Error + close frames channel + clear the [started] latch so a
     * retry start() is not blocked (idempotent). No engine release (caller's job).
     */
    private fun failSoft(reason: String): Boolean {
        log.warn("start-failed", mapOf("reason" to reason))
        started = false
        _state.value = MicState.Error(reason)
        currentChannel.close()
        return false
    }
}
