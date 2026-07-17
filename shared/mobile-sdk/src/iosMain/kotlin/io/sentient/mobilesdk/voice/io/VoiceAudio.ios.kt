// ---------------------------------------------------------------------------
// VoiceAudio.ios.kt — ONE AVAudioEngine serving every (mic, playback) state.
//
// Consolidates the proven iOS audio snippets (mic tap, playback player, full-duplex
// session, ObjCExceptionGuard) into one engine. configure(mic, playback, rate) diffs voiceAudioGraph against
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
import platform.AVFAudio.AVAudioSessionModeVideoChat
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

// Software mic gain applied to captured PCM16 in the tap. iOS delivers far-field
// speech quiet (measured server rms 0.003–0.08 vs webui 0.03–0.2), so we boost
// deterministically here instead of fighting iOS's session-mode processing.
// ×4.25 (far-field ~0.01→0.043, close speech stays under hard-clip); tune from
// the "capture-level" log below. 1.0f = no boost.
private const val MIC_CAPTURE_GAIN = 4.25f
// Throttle the capture-level meter log — the tap fires ~10×/s, so every 50 ≈ 5s.
private const val METER_LOG_EVERY = 50

// Software playback makeup gain applied to the downlink PCM before the player. The
// stable VoIP session (.playAndRecord + .videoChat — see activateSession) plays TTS on
// the voice-tuned route, well below media-route loudness, and no route change is safe
// (the one-stable-session design is load-bearing). This gain lifts the floor; peaks
// hard-clamp to [-1,1] in pcm16ToFloatBuffer, so past ~×6 loud peaks clip audibly —
// prefer the in-call volume slider (during playback) + VPIO ducking .min over pushing
// this higher. Do NOT normalize per-voice — quiet voices are a character trait.
// 1.0f = no boost.
private const val PLAYBACK_MAKEUP_GAIN = 5.5f

/**
 * ONE AVAudioEngine serving every (mic, playback) state. session = .playAndRecord +
 * .videoChat (one stable VoIP mode that survives reconfigure; capture level handled by
 * MIC_CAPTURE_GAIN in the tap, AEC by the per-cell VPIO toggle — see activateSession).
 * Activated on first non-idle configure, deactivated at idle/shutdown.
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

    // Bounded SUSPEND channel; drop-newest via trySend (mirrors the prior iOS mic tap).
    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()

    // The currently-applied graph; configure diffs against this.
    private var current: VoiceAudioGraph = voiceAudioGraph(mic = false, playback = false)

    // Mic-tap state (built lazily on first installTap; reset on removeTap).
    private var converter: Pcm16Converter? = null
    private var capturedCount = 0
    private var droppedCount = 0

    // Playback drain tracking — outstanding scheduled buffers + generation guard
    // (mirrors the prior iOS playback adapter). AtomicInt: completion fires on the audio
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
            if (desired.running) {
                // I1: a session-activate failure (setCategory/setActive) must abort
                // configure BEFORE applyGraph/ensureRunning run on an un-activated
                // session — otherwise the engine proceeds to Phase.Ready with no audio
                // route, silently dead. Match the ensureRunning()-check pattern (T4).
                if (!activateSession()) {
                    failReset(mic, playback, "session-activate-failed")
                    return
                }
            } else {
                deactivateSession()
            }
            applyGraph(desired, playbackRateHz)
            if (desired.running && !ensureRunning()) {
                failReset(mic, playback, "engine-start-failed")
                return
            }
            current = desired
        }.onFailure { err ->
            // Partial-failure state desync fix: applyGraph may have attached the player /
            // installed the tap before a later step threw. Leaving `current` at the old
            // graph while the engine holds a half-built graph desyncs the next configure
            // (it re-runs attachPlayer → double-attach + resets outstanding/epoch → the
            // drain counter corrupts → isPlaybackIdle sticks). Hard-reset to a clean idle
            // baseline so the next configure rebuilds from scratch.
            failReset(mic, playback, err.message ?: "unknown")
            return
        }
        _state.value = VoiceAudioState(Phase.Ready, micActive = mic, playbackActive = playback)
    }

    /**
     * A configure failure: force the engine + [current] back to a clean idle baseline so
     * the next configure never diffs against a half-built graph. Tears down any
     * partially-applied tap/player, deactivates the session, and resets the drain
     * counters. [current] becomes graph(false,false); the caller retries from scratch.
     */
    private fun failReset(mic: Boolean, playback: Boolean, reason: String) {
        runCatching { engine.stop() }
        runCatching { engine.inputNode.removeTapOnBus(INPUT_BUS) }
        runCatching { if (current.player) { player.stop(); engine.detachNode(player) } }
        deactivateSession()
        converter = null
        playerFormat = null
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        current = voiceAudioGraph(mic = false, playback = false)
        _state.value = VoiceAudioState(Phase.Error, micActive = mic, playbackActive = playback, errorReason = reason)
        log.warn("configure-failed", mapOf("reason" to reason))
    }

    /** Activate .playAndRecord + .videoChat — ONE stable VoIP mode (no fragile per-cell
     *  mode switching). NOTE: .measurement was tried for its raw far-field capture but
     *  it does NOT survive the engine stop→reconfigure→start — after one TTS turn the
     *  tap AND playback went dead (round 2 silent). A per-cell .playback↔.playAndRecord
     *  CATEGORY split was tried TWICE (two-engine era per 2633b4e, and again 2026-07)
     *  and BOTH times the handoff killed audio (no TTS + mic dead after round 1) —
     *  the one-stable-session design is load-bearing; do NOT reintroduce route-by-
     *  activity here. .videoChat is a VoIP mode (like the original .voiceChat) that
     *  reconfigures cleanly, is hands-free-tuned for far-field, and is VPIO-compatible
     *  for barge-in AEC. iOS still delivers far-field quiet, so the CAPTURE LEVEL is
     *  handled deterministically by MIC_CAPTURE_GAIN in the tap.
     *  Returns true only when BOTH setCategory + setActive succeed (I1 abort); speaker
     *  override is best-effort. */
    private fun activateSession(): Boolean = memScoped {
        val s = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = s.setCategory(
            AVAudioSessionCategoryPlayAndRecord,
            mode = AVAudioSessionModeVideoChat,
            options = AVAudioSessionCategoryOptionDefaultToSpeaker,
            error = errVar.ptr,
        )
        if (!categorySet) {
            log.warn("session-category-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        val activated = s.setActive(true, errVar.ptr)
        if (!activated) {
            log.warn("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        // Force the LOUD speaker route. Canonical speakerphone toggle; keeps
        // voice-processing AEC intact for barge-in.
        val routed = s.overrideOutputAudioPort(AVAudioSessionPortOverrideSpeaker, errVar.ptr)
        if (!routed) log.warn("session-speaker-override-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
        log.debug("session-active", mapOf("category" to "playAndRecord", "mode" to "videoChat", "override" to "speaker"))
        true
    }

    private fun deactivateSession() {
        runCatching { AVAudioSession.sharedInstance().setActive(false, null) }
            .onFailure { log.warn("session-deactivate-failed", mapOf("cause" to (it.message ?: "unknown"))) }
    }

    /**
     * Apply the graph diff to the ONE engine. VPIO toggled ONLY here (engine is
     * stopped above), so it always starts on a clean session. Player is always
     * connected to mainMixerNode so it never starts "disconnected" (interim 2633b4e).
     *
     * ``setInputVoiceProcessing`` REBUILDS the input audio unit, which invalidates any
     * live mic tap — so a mic that STAYS on across a VPIO toggle needs its tap
     * re-installed. The plain "install only when newly mic" check missed this (inputTap
     * stays true), which left the mic silently dead after the first TTS round (VPIO
     * flips on for mic+playback, then off again → tap killed twice, never re-added).
     */
    private fun applyGraph(g: VoiceAudioGraph, rate: Int) {
        val vpioChanged = g.vpio != current.vpio
        if (vpioChanged) setInputVoiceProcessing(g.vpio)
        when {
            g.inputTap && !current.inputTap -> installTap()
            g.inputTap && vpioChanged -> { removeTap(); installTap() }  // VPIO rebuilt the unit → re-tap
            !g.inputTap && current.inputTap -> removeTap()
        }
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
            // I2: throw so the outer runCatching in configure catches it → Phase.Error.
            // A silent return left current.inputTap=true + Phase.Ready with micFrames
            // cold → uplink silently dead. Match the T4 VPIO-failure pattern.
            log.warn("mic-unavailable", mapOf("inputRate" to inputFormat.sampleRate, "channels" to inputFormat.channelCount.toLong()))
            throw IllegalStateException("mic-unavailable")
        }
        val conv = Pcm16Converter(inputFormat, TARGET_SAMPLE_RATE_HZ)
        if (!conv.isReady) {
            log.warn("converter-init-failed", mapOf("inputRate" to inputFormat.sampleRate))
            throw IllegalStateException("converter-init-failed")
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
        val shorts = pcm16LeToShorts(bytes)
        meterAndGain(shorts)
        deliver(shorts)
    }

    /** Log the RAW capture RMS (throttled — for gain tuning), then apply
     *  MIC_CAPTURE_GAIN in-place, clamped to Int16. iOS delivers far-field speech
     *  quiet; this normalizes it up to webui's level so one server rms floor fits
     *  both. rmsRaw is an aggregate energy level, not content — safe to log. */
    private fun meterAndGain(shorts: ShortArray) {
        if (shorts.isEmpty()) return
        if (capturedCount == 1 || capturedCount % METER_LOG_EVERY == 0) {
            var sum = 0.0
            for (s in shorts) { val f = s / 32768.0; sum += f * f }
            val rmsRaw = kotlin.math.sqrt(sum / shorts.size)
            log.debug("capture-level", mapOf("rmsRaw" to rmsRaw, "gain" to MIC_CAPTURE_GAIN, "frames" to shorts.size))
        }
        if (MIC_CAPTURE_GAIN == 1.0f) return
        for (i in shorts.indices) {
            val v = (shorts[i] * MIC_CAPTURE_GAIN).toInt()
            shorts[i] = when {
                v > Short.MAX_VALUE.toInt() -> Short.MAX_VALUE
                v < Short.MIN_VALUE.toInt() -> Short.MIN_VALUE
                else -> v.toShort()
            }
        }
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
        val buffer = pcm16ToFloatBuffer(pcm16, format, PLAYBACK_MAKEUP_GAIN) ?: return
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
        memScoped {
            val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
            val ok = input.setVoiceProcessingEnabled(enabled, errVar.ptr)
            if (!ok) throw IllegalStateException("vpio enable failed")
        }
        log.info("vpio", mapOf("enabled" to enabled))
    }

    private companion object {
        // Dropped-frame WARN throttle: warn on the first drop + every Nth after.
        const val DROP_WARN_EVERY = 50
    }
}
