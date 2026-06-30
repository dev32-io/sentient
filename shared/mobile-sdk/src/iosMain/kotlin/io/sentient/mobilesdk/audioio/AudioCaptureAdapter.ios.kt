// ---------------------------------------------------------------------------
// AudioCaptureAdapter.ios.kt — AVAudioEngine-backed mic capture (iOS).
//
// Uses the SHARED AVAudioEngine ([SharedAudioEngine]) input node with
// voice-processing IO enabled (setVoiceProcessingEnabled(true)) for platform AEC
// + noise suppression — the iOS analogue of Android's VOICE_COMMUNICATION
// source. Capture acquires the engine via retainForCapture()/releaseForCapture()
// so SharedAudioEngine.isCaptureActive reads true while the mic holds it — that
// flag is how E2 playback decides between the shared playAndRecord engine (this
// path, full-duplex AEC) and a standalone .playback engine (text chat, no mic).
// In VOICE MODE the shared engine + .playAndRecord/.voiceChat session are ALSO
// used by the E2 playback player node so the VP unit gets the speaker render
// reference (full-duplex AEC — see SharedAudioEngine.ios.kt). An input tap hands float
// buffers at the hardware rate (often 48k); Pcm16Converter resamples each to 16k
// mono PCM16 LE, which is pushed into a buffered Channel that frames() exposes as
// a cold Flow.
//
// NO-CRASH CONTRACT (error-handling rule): start() catches every failure
// (mic-permission denied, session activation refused, engine start error) and
// closes the frames channel cleanly instead of throwing across the @ObjCExport
// boundary (which K/N traps as SIGABRT). The E3 pipeline observes the completed
// Flow as a failed start. NSMicrophoneUsageDescription is declared in
// ios/project.yml; the runtime prompt is the app's responsibility (E5/E6).
//
// INVALID-MIC GUARD (E5 sim crash fix): Kotlin/Native `runCatching` only catches
// Kotlin `Throwable`, NOT the ObjC `NSException`s that AVAudioEngine raises. On a
// simulator with no real mic the engine has no audio I/O route, so
// SharedAudioEngine.retain()'s engine.prepare()/start() raises "inputNode != nullptr
// || outputNode != nullptr" — caught by an ObjC @try/@catch shim in SharedAudioEngine
// (the primary fix; see ObjCExceptionGuard.ios.kt). retain() then returns null and
// start() fails soft here BEFORE any capture-side AV call. As a second line of
// defense (engine starts but the mic route is still invalid), this adapter reads +
// validates inputFormatForBus(0) BEFORE setVoiceProcessingEnabled / installTapOnBus
// (which raise an NSException on a zero format): an invalid format short-circuits to
// a soft fail (WARN + release the shared-engine retain so the refcount stays
// consistent + false return). A REAL device reports a valid format → capture
// proceeds normally.
//
// K/N AVFoundation cinterop: ObjC interop is cleaner than the Security CF layer
// — direct member calls, no toll-free dict casts. The two foreign-pointer spots
// are the converter int16ChannelData read (in Pcm16Converter) and the NSError**
// out-params here, handled CF-natively via memScoped alloc + .ptr.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.receiveAsFlow
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioInputNode
import platform.AVFAudio.AVAudioPCMBuffer
import platform.Foundation.NSError
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "capture", "ios")

private const val INPUT_BUS = 0uL
private const val OUTPUT_BUS = 0uL
private const val TAP_BUFFER_FRAMES = 1024u
private const val FRAME_CHANNEL_CAPACITY = 64

// EXPERIMENT: capture-side voice processing (AEC+NS+AGC). The VP I/O unit is the coupled
// full-duplex unit behind the real-device cascade (empty-graph prepare throw → vpio render
// -1 → dead input tap). Disabled to confirm it's the cause and get reliable plain-input
// capture (also the Whisper less-DSP direction). Flip to true to restore the always-on AEC.
private const val ENABLE_CAPTURE_VOICE_PROCESSING = false

// Tap-buffer trace throttle: log the first N buffers + every Nth after (keeps the
// uplink trace visible without flooding the vitals ring at ~10 buffers/sec).
private const val CAPTURE_TRACE_FIRST = 5
private const val CAPTURE_TRACE_EVERY = 25

/**
 * iOS [AudioCaptureAdapter] backed by the shared [AVAudioEngine].
 *
 * Obtains the running engine from [SharedAudioEngine] (also used by E2 playback)
 * and installs an input tap. The tap callback runs on the audio render thread;
 * it does non-blocking [Channel.trySend] only.
 */
class IosAudioCaptureAdapter : AudioCaptureAdapter {

    private val shared = SharedAudioEngine.instance

    @Volatile
    private var engine: AVAudioEngine? = null

    @Volatile
    private var frameChannel: Channel<ByteArray>? = null

    // Diagnostic: logs only the FIRST tap buffer per capture session, so logs tell
    // "tap never fired" (no line) apart from "tap fired but frames gated downstream".
    @Volatile
    private var tapFiredOnce = false

    // Running count of tap buffers this session (audio-thread only — set serially).
    private var capturedCount = 0

    override fun frames(sampleRate: Int): Flow<ByteArray> {
        val channel = frameChannel
        if (channel == null) {
            log.warn("frames-no-session", mapOf("reason" to "start() not called or failed"))
            return emptyFlow()
        }
        return channel.receiveAsFlow()
    }

    override suspend fun start(sampleRate: Int) {
        if (engine != null) {
            log.debug("start-already-active", mapOf("sampleRate" to sampleRate))
            return
        }
        log.info("start", mapOf("sampleRate" to sampleRate))
        val channel = Channel<ByteArray>(
            capacity = FRAME_CHANNEL_CAPACITY,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        frameChannel = channel
        tapFiredOnce = false
        capturedCount = 0
        val started = runCatching { startEngine(sampleRate, channel) }.getOrElse { e ->
            log.error("start-failed", mapOf("reason" to "exception", "cause" to (e.message ?: "unknown")))
            false
        }
        if (!started) {
            channel.close()
            frameChannel = null
        }
    }

    override suspend fun stop() {
        val active = engine ?: run {
            log.debug("stop-noop")
            return
        }
        engine = null
        log.info("stop")
        runCatching { active.inputNode.removeTapOnBus(INPUT_BUS) }
            .onFailure { log.warn("stop-teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        shared.releaseForCapture()
        frameChannel?.close()
        frameChannel = null
    }

    // -----------------------------------------------------------------------
    // Engine setup
    // -----------------------------------------------------------------------

    /**
     * Acquires the shared engine + installs the tap; returns false on any failure
     * (no throw). The shared engine's prepare/start (the sim crash origin) is already
     * guarded by an ObjC @try/@catch in [SharedAudioEngine] — on the sim with no
     * audio route retain() returns null here, so the throwing capture-side AV calls
     * (inputFormatForBus / setVoiceProcessingEnabled / installTapOnBus) are never
     * reached. The format-validation guard below is the second line of defense: if
     * the engine DOES start but the mic route is invalid, we short-circuit BEFORE the
     * AV calls that would raise an NSException. On any failure the shared-engine
     * retain is released so the refcount stays consistent.
     */
    private fun startEngine(sampleRate: Int, channel: Channel<ByteArray>): Boolean {
        val avEngine = shared.retainForCapture() ?: return false
        val input: AVAudioInputNode = avEngine.inputNode

        // Guard against a zero format (sim with no mic / no input route) BEFORE any
        // throwing AV call — setVoiceProcessing / installTap raise an NSException on a
        // zero format that runCatching cannot catch (→ SIGABRT).
        val preVpFormat = input.inputFormatForBus(INPUT_BUS)
        if (!isValidInputFormat(preVpFormat)) {
            log.warn(
                "mic-unavailable",
                mapOf(
                    "reason" to "invalid input format, capture not started",
                    "inputRate" to preVpFormat.sampleRate,
                    "channels" to preVpFormat.channelCount.toLong(),
                ),
            )
            shared.releaseForCapture()
            return false
        }

        // Enabling voice processing CHANGES the input node's format. Read the EFFECTIVE
        // format AFTER the (optional) VP toggle and bind BOTH the converter and the tap to
        // it — a tap installed with a stale format silently never delivers buffers.
        if (ENABLE_CAPTURE_VOICE_PROCESSING) enableVoiceProcessing(input)
        val inputFormat = input.inputFormatForBus(INPUT_BUS)
        log.info(
            "input-format",
            mapOf(
                "preVpRate" to preVpFormat.sampleRate,
                "postVpRate" to inputFormat.sampleRate,
                "channels" to inputFormat.channelCount.toLong(),
            ),
        )
        if (!isValidInputFormat(inputFormat)) {
            log.warn("mic-unavailable", mapOf("reason" to "invalid post-VP format", "rate" to inputFormat.sampleRate))
            shared.releaseForCapture()
            return false
        }

        val converter = Pcm16Converter(inputFormat, sampleRate)
        if (!converter.isReady) {
            log.error("start-failed", mapOf("reason" to "converter init", "inputRate" to inputFormat.sampleRate))
            shared.releaseForCapture()
            return false
        }

        input.installTapOnBus(INPUT_BUS, bufferSize = TAP_BUFFER_FRAMES, format = inputFormat) { buffer, _ ->
            forwardBuffer(buffer, converter, channel)
        }

        // The voice-processing I/O unit is a COUPLED mic+speaker unit: it needs a live
        // OUTPUT render or it fails every cycle ("auou/vpio render err -1"). So ONLY when VP
        // is on, reference mainMixerNode to establish the mainMixer→outputNode link before
        // prepare/start (renders silence until E2 playback connects its player to this SAME
        // mixer; outputVolume untouched). A plain (VP-off) input tap needs no output graph.
        if (ENABLE_CAPTURE_VOICE_PROCESSING) {
            val outputMixer = avEngine.mainMixerNode
            log.debug("output-graph-ensured", mapOf("outputRate" to outputMixer.outputFormatForBus(OUTPUT_BUS).sampleRate))
        }

        // Installing a tap can restart the engine graph; ensure it is running.
        if (!shared.ensureRunning()) {
            input.removeTapOnBus(INPUT_BUS)
            shared.releaseForCapture()
            return false
        }
        engine = avEngine
        log.info("session-open", mapOf("inputRate" to inputFormat.sampleRate, "targetRate" to sampleRate))
        return true
    }

    /**
     * True when [format] describes a usable mic route. A simulator with no real
     * mic (or a device with no input route) reports a zero format (0 sampleRate /
     * 0 channels); feeding that to setVoiceProcessingEnabled / installTapOnBus
     * raises an ObjC NSException that runCatching cannot catch (→ SIGABRT).
     */
    private fun isValidInputFormat(format: AVAudioFormat): Boolean =
        format.sampleRate > 0.0 && format.channelCount > 0u

    /** Pushes one converted PCM16 LE frame into [channel] (audio-thread safe). */
    private fun forwardBuffer(buffer: AVAudioPCMBuffer?, converter: Pcm16Converter, channel: Channel<ByteArray>) {
        if (buffer == null) return
        capturedCount += 1
        val trace = capturedCount <= CAPTURE_TRACE_FIRST || capturedCount % CAPTURE_TRACE_EVERY == 0
        if (!tapFiredOnce) {
            tapFiredOnce = true
            log.info("tap-first-buffer", mapOf("frames" to buffer.frameLength.toLong()))
        }
        if (trace) log.debug("tap-buffer", mapOf("frames" to buffer.frameLength.toLong(), "count" to capturedCount))
        val pcm = converter.convert(buffer)
        if (pcm == null) {
            if (trace) log.debug("tap-frame-dropped", mapOf("reason" to "convert-null", "count" to capturedCount))
            return
        }
        val queued = channel.trySend(pcm).isSuccess
        if (trace) log.debug("tap-frame-queued", mapOf("bytes" to pcm.size, "queued" to queued, "count" to capturedCount))
    }

    /** Enables voice-processing IO (platform AEC) on the input node; logs availability. */
    private fun enableVoiceProcessing(input: AVAudioInputNode) {
        val enabled = memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
            val ok = input.setVoiceProcessingEnabled(true, errVar.ptr)
            if (!ok) log.warn("voice-processing-unavailable", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            ok
        }
        log.info("voice-processing", mapOf("enabled" to enabled))
    }
}
