// ---------------------------------------------------------------------------
// VoiceAudio.ios.kt — ONE AVAudioEngine serving every (mic, playback) state.
//
// Consolidates the proven snippets from the soon-deleted iOS files
// (IosMicSource / AudioPlaybackAdapter / SharedAudioEngine / ObjCExceptionGuard)
// into one engine. configure(mic, playback, rate) diffs voiceAudioGraph against
// the last-applied graph, then stop → reconfigure (tap/player/VPIO) → start.
// VPIO toggled ONLY in the mic+playback cell, only inside a stop → always starts
// on a clean session (kills StartIO-on-dirty-session). Player always connected to
// mainMixerNode → never starts disconnected (kills the 2633b4e crash class).
//
// NO-CRASH: every AV call wrapped (runCatching / enginePrepareGuarded /
// engineStartGuarded / memScoped NSError**). Failures become Phase.Error, never
// a throw across @ObjCExport (K/N traps a thrown Throwable as SIGABRT).
//
// DEVICE-VERIFIED (sim has no mic → no unit test). Compile GREEN is the agent gate;
// device mic run is user-owned. Logs lengths/counts/ids ONLY (PrivacyGuard safe).
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.enginePrepareGuarded
import io.sentient.mobilesdk.audioio.engineStartGuarded
import io.sentient.mobilesdk.audioio.pcm16ToFloatBuffer
import io.sentient.mobilesdk.audioio.Pcm16Converter
import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPlayerNode
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryOptionDefaultToSpeaker
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionModeVoiceChat
import platform.AVFAudio.AVAudioSessionPortOverrideSpeaker
import platform.AVFAudio.setActive
import platform.Foundation.NSError
import kotlin.concurrent.AtomicInt
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val FRAME_CHANNEL_CAPACITY = 16
private const val INPUT_BUS = 0uL
private const val OUTPUT_BUS = 0uL
private const val TAP_BUFFER_FRAMES = 1024u
private const val MONO_CHANNELS = 1u

/**
 * ONE AVAudioEngine serving every (mic, playback) state. session = .playAndRecord +
 * .voiceChat, activated on first non-idle configure, deactivated at idle/shutdown.
 * configure() diffs [voiceAudioGraph] against the current graph: stop → reconfigure
 * (tap/player/VPIO) → ensureRunning. VPIO enabled ONLY in the mic+playback cell, and
 * only inside a stop→reconfigure→start (never on a live engine) → always starts on a
 * clean session (kills the StartIO-on-dirty-session bug class).
 */
class IosVoiceAudio : VoiceAudio {
    private val log = createLogger("voice", "engine", "ios")

    private val engine = AVAudioEngine()
    private val player = AVAudioPlayerNode()

    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    // Bounded SUSPEND channel; drop-newest via trySend (mirrors IosMicSource).
    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()

    // The currently-applied graph; configure diffs against this.
    private var current: VoiceAudioGraph = voiceAudioGraph(mic = false, playback = false)

    // Mic-tap state (built lazily on first installTap; reset on removeTap).
    private var converter: Pcm16Converter? = null
    private var capturedCount = 0
    private var droppedCount = 0

    // Playback drain tracking — outstanding scheduled buffers + generation guard
    // (mirrors AudioPlaybackAdapter). AtomicInt: completion fires on the audio
    // render thread; the counter is read here on the orchestrator coroutine.
    private val outstanding = AtomicInt(0)
    private val playbackEpoch = AtomicInt(0)
    private var playerFormat: AVAudioFormat? = null

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) {
        val desired = voiceAudioGraph(mic, playback)
        if (desired == current) {
            log.debug("configure-noop", mapOf("mic" to mic, "playback" to playback))
            return
        }
        log.info(
            "configure",
            mapOf("mic" to mic, "playback" to playback, "vpio" to desired.vpio, "rate" to playbackRateHz),
        )
        _state.value = _state.value.copy(phase = Phase.Configuring, micActive = mic, playbackActive = playback)
        runCatching {
            engine.stop()
            if (desired.running) activateSession() else deactivateSession()
            applyGraph(desired, playbackRateHz)
            if (desired.running) ensureRunning()
            current = desired
        }.onFailure { err ->
            _state.value = VoiceAudioState(Phase.Error, micActive = mic, playbackActive = playback, errorReason = err.message)
            log.warn("configure-failed", mapOf("reason" to (err.message ?: "unknown")))
            return
        }
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    private fun activateSession() = memScoped {
        val s = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = s.setCategory(
            AVAudioSessionCategoryPlayAndRecord,
            mode = AVAudioSessionModeVoiceChat,
            options = AVAudioSessionCategoryOptionDefaultToSpeaker,
            error = errVar.ptr,
        )
        if (!categorySet) {
            log.warn("session-category-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped
        }
        val activated = s.setActive(true, errVar.ptr)
        if (!activated) {
            log.warn("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped
        }
        // Force the LOUD bottom speaker (.voiceChat mode otherwise routes to the earpiece).
        // Canonical speakerphone toggle; keeps voice-processing AEC intact for barge-in.
        val routed = s.overrideOutputAudioPort(AVAudioSessionPortOverrideSpeaker, errVar.ptr)
        if (!routed) log.warn("session-speaker-override-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
        log.debug("session-active", mapOf("category" to "playAndRecord", "mode" to "voiceChat", "override" to "speaker"))
    }

    private fun deactivateSession() {
        runCatching { AVAudioSession.sharedInstance().setActive(false, null) }
            .onFailure { log.warn("session-deactivate-failed", mapOf("cause" to (it.message ?: "unknown"))) }
    }

    /**
     * Apply the graph diff to the ONE engine. VPIO toggled ONLY here (engine is
     * stopped above), so it always starts on a clean session. Player is always
     * connected to mainMixerNode so it never starts "disconnected" (interim 2633b4e).
     */
    private fun applyGraph(g: VoiceAudioGraph, rate: Int) {
        if (g.vpio != current.vpio) setInputVoiceProcessing(g.vpio)
        if (g.inputTap && !current.inputTap) installTap()
        if (!g.inputTap && current.inputTap) removeTap()
        if (g.player && !current.player) attachPlayer(rate)
        if (!g.player && current.player) detachPlayer()
    }

    private fun ensureRunning(): Boolean {
        if (engine.running) return true
        if (!enginePrepareGuarded(engine)) return false
        return engineStartGuarded(engine)
    }

    // ── Mic tap (48k→16k convert-in-tap, drop-newest) ────────────────────────────
    private fun installTap() {
        val input = engine.inputNode
        val inputFormat = input.inputFormatForBus(INPUT_BUS)
        if (inputFormat.sampleRate <= 0.0 || inputFormat.channelCount <= 0u) {
            log.warn("mic-unavailable", mapOf("inputRate" to inputFormat.sampleRate, "channels" to inputFormat.channelCount.toLong()))
            return
        }
        val conv = Pcm16Converter(inputFormat, TARGET_SAMPLE_RATE_HZ)
        if (!conv.isReady) {
            log.warn("converter-init-failed", mapOf("inputRate" to inputFormat.sampleRate))
            return
        }
        capturedCount = 0
        droppedCount = 0
        input.installTapOnBus(INPUT_BUS, bufferSize = TAP_BUFFER_FRAMES, format = inputFormat) { buffer, _ ->
            forwardBuffer(buffer, conv)
        }
        // Establish the OUTPUT graph (mainMixer→outputNode) BEFORE start — ALWAYS.
        // E2 playback attaches its player to this SAME mixer; without the output half
        // the player start()s "in a disconnected state" (crash + silent TTS).
        val outputMixer = engine.mainMixerNode
        log.debug(
            "tap-installed",
            mapOf("inputRate" to inputFormat.sampleRate, "targetRate" to TARGET_SAMPLE_RATE_HZ, "outputRate" to outputMixer.outputFormatForBus(OUTPUT_BUS).sampleRate),
        )
        converter = conv
    }

    private fun removeTap() {
        runCatching { engine.inputNode.removeTapOnBus(INPUT_BUS) }
            .onFailure { log.warn("remove-tap-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        converter = null
    }

    /** Convert one tap buffer to 16k PCM16 ShortArray and deliver (audio-thread safe). */
    private fun forwardBuffer(buffer: platform.AVFAudio.AVAudioPCMBuffer?, conv: Pcm16Converter) {
        if (buffer == null) return
        capturedCount += 1
        val bytes = conv.convert(buffer) ?: return
        deliver(pcm16LeToShorts(bytes))
    }

    /** trySend the frame; on a full buffer drop the NEWEST + count it (throttled WARN). */
    private fun deliver(shorts: ShortArray) {
        if (micCh.trySend(shorts).isSuccess) return
        droppedCount += 1
        if (droppedCount == 1 || droppedCount % DROP_WARN_EVERY == 0) {
            log.warn("frame-dropped", mapOf("reason" to "channel-full", "dropped" to droppedCount, "count" to capturedCount))
        }
    }

    // ── Playback (AVAudioPlayerNode → mainMixerNode) ──────────────────────────────
    private fun attachPlayer(rate: Int) {
        val format = AVAudioFormat(standardFormatWithSampleRate = rate.toDouble(), channels = MONO_CHANNELS)
        engine.attachNode(player)
        engine.connect(player, to = engine.mainMixerNode, format = format)
        playerFormat = format
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        log.info("player-attached", mapOf("rate" to rate))
    }

    private fun detachPlayer() {
        runCatching {
            player.stop()
            engine.detachNode(player)
        }.onFailure { log.warn("detach-player-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        playerFormat = null
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
    }

    override fun playFrame(pcm16: ByteArray) {
        if (!current.player) return
        val format = playerFormat ?: return
        val buffer = pcm16ToFloatBuffer(pcm16, format) ?: return
        val epochAtSchedule = playbackEpoch.value
        outstanding.incrementAndGet()
        runCatching {
            player.scheduleBuffer(buffer, completionHandler = {
                if (playbackEpoch.value == epochAtSchedule) outstanding.decrementAndGet()
            })
            if (!player.playing) player.play()
        }.onFailure {
            if (playbackEpoch.value == epochAtSchedule) outstanding.decrementAndGet()
            log.error("play-frame-failed", mapOf("cause" to (it.message ?: "unknown"), "bytes" to pcm16.size))
        }
    }

    override fun flushPlayback() {
        playbackEpoch.incrementAndGet()
        outstanding.value = 0
        runCatching { player.stop() }
            .onFailure { log.warn("flush-playback-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        log.info("flush-playback", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    override val isPlaybackIdle: Boolean get() = outstanding.value == 0

    override suspend fun shutdown() {
        log.info("shutdown", mapOf("captured" to capturedCount, "dropped" to droppedCount))
        runCatching { engine.stop() }
        runCatching { engine.inputNode.removeTapOnBus(INPUT_BUS) }
        runCatching { if (current.player) { player.stop(); engine.detachNode(player) } }
        deactivateSession()
        micCh.close()
        converter = null
        playerFormat = null
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        current = voiceAudioGraph(mic = false, playback = false)
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
    }

    private fun setInputVoiceProcessing(enabled: Boolean) {
        val input = engine.inputNode
        val ok = memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
            input.setVoiceProcessingEnabled(enabled, errVar.ptr).also {
                if (!it) log.warn("vpio-set-failed", mapOf("enabled" to enabled, "error" to (errVar.value?.localizedDescription ?: "unknown")))
            }
        }
        log.info("vpio", mapOf("enabled" to enabled, "ok" to ok))
    }

    private companion object {
        // Dropped-frame WARN throttle: warn on the first drop + every Nth after.
        const val DROP_WARN_EVERY = 50
    }
}