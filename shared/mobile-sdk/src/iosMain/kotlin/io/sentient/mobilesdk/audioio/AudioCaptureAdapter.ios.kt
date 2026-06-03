// ---------------------------------------------------------------------------
// AudioCaptureAdapter.ios.kt — AVAudioEngine-backed mic capture (iOS).
//
// Uses the AVAudioEngine input node with voice-processing IO enabled
// (setVoiceProcessingEnabled(true)) for platform AEC + noise suppression — the
// iOS analogue of Android's VOICE_COMMUNICATION source. The AVAudioSession is
// configured .playAndRecord / .voiceChat (the AEC-friendly mode). An input tap
// hands float buffers at the hardware rate (often 48k); Pcm16Converter resamples
// each to 16k mono PCM16 LE, which is pushed into a buffered Channel that
// frames() exposes as a cold Flow.
//
// NO-CRASH CONTRACT (error-handling rule): start() catches every failure
// (mic-permission denied, session activation refused, engine start error) and
// closes the frames channel cleanly instead of throwing across the @ObjCExport
// boundary (which K/N traps as SIGABRT). The E3 pipeline observes the completed
// Flow as a failed start. NSMicrophoneUsageDescription is declared in
// ios/project.yml; the runtime prompt is the app's responsibility (E5/E6).
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
import platform.AVFAudio.AVAudioInputNode
import platform.AVFAudio.AVAudioPCMBuffer
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryOptionDefaultToSpeaker
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionModeVoiceChat
import platform.AVFAudio.setActive
import platform.Foundation.NSError
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "capture", "ios")

private const val INPUT_BUS = 0uL
private const val TAP_BUFFER_FRAMES = 1024u
private const val FRAME_CHANNEL_CAPACITY = 64

/**
 * iOS [AudioCaptureAdapter] backed by [AVAudioEngine].
 *
 * One [AVAudioEngine] + input tap per capture run. The tap callback runs on the
 * audio render thread; it does non-blocking [Channel.trySend] only.
 */
class IosAudioCaptureAdapter : AudioCaptureAdapter {

    @Volatile
    private var engine: AVAudioEngine? = null

    @Volatile
    private var frameChannel: Channel<ByteArray>? = null

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
        runCatching {
            active.inputNode.removeTapOnBus(INPUT_BUS)
            active.stop()
            AVAudioSession.sharedInstance().setActive(false, null)
        }.onFailure { log.warn("stop-teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        frameChannel?.close()
        frameChannel = null
    }

    // -----------------------------------------------------------------------
    // Engine setup
    // -----------------------------------------------------------------------

    /** Configures the session + engine + tap; returns false on any failure (no throw). */
    private fun startEngine(sampleRate: Int, channel: Channel<ByteArray>): Boolean {
        if (!configureSession()) return false

        val avEngine = AVAudioEngine()
        val input: AVAudioInputNode = avEngine.inputNode
        enableVoiceProcessing(input)

        val inputFormat = input.inputFormatForBus(INPUT_BUS)
        val converter = Pcm16Converter(inputFormat, sampleRate)
        if (!converter.isReady) {
            log.error("start-failed", mapOf("reason" to "converter init", "inputRate" to inputFormat.sampleRate))
            return false
        }

        input.installTapOnBus(INPUT_BUS, bufferSize = TAP_BUFFER_FRAMES, format = inputFormat) { buffer, _ ->
            forwardBuffer(buffer, converter, channel)
        }

        avEngine.prepare()
        val ok = memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
            val success = avEngine.startAndReturnError(errVar.ptr)
            if (!success) log.error("engine-start-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            success
        }
        if (!ok) {
            input.removeTapOnBus(INPUT_BUS)
            return false
        }
        engine = avEngine
        log.info("session-open", mapOf("inputRate" to inputFormat.sampleRate, "targetRate" to sampleRate))
        return true
    }

    /** Pushes one converted PCM16 LE frame into [channel] (audio-thread safe). */
    private fun forwardBuffer(buffer: AVAudioPCMBuffer?, converter: Pcm16Converter, channel: Channel<ByteArray>) {
        if (buffer == null) return
        val pcm = converter.convert(buffer) ?: return
        channel.trySend(pcm)
    }

    /** Configures AVAudioSession for AEC voice capture. Returns false on failure. */
    private fun configureSession(): Boolean = memScoped {
        val session = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = session.setCategory(
            AVAudioSessionCategoryPlayAndRecord,
            mode = AVAudioSessionModeVoiceChat,
            options = AVAudioSessionCategoryOptionDefaultToSpeaker,
            error = errVar.ptr,
        )
        if (!categorySet) {
            log.error("session-category-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        val activated = session.setActive(true, errVar.ptr)
        if (!activated) {
            log.error("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        log.debug("session-configured", mapOf("category" to "playAndRecord", "mode" to "voiceChat"))
        true
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
