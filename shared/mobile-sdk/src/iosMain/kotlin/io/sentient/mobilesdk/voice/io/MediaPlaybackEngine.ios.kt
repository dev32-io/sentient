// ---------------------------------------------------------------------------
// MediaPlaybackEngine.ios.kt — playback-only AVAudioEngine for the Manual (hold/idle)
// reply path. NEVER touches inputNode (a live input unit under .playback starts DEAD —
// the structural root of the twice-shipped round-2-silent bug).
//
// Scoped session (mirrors ios/App/Settings/Voice/VoiceSamplePlayer.swift, proven in
// this app): .playback category + .default mode, activate on arm,
// setActive(false, notifyOthersOnDeactivation) on teardown. This is the LOUD media
// route — output at media loudness, volume buttons control the media stream at any
// time (the whole point of the hold/toggle split, spec §1/§7.1).
//
// Same playFrame/flushPlayback/isPlaybackIdle drain-counter contract as DuplexEngine's
// player half (outstanding + epoch pattern, copied). Used for (mic=F, playback=T,
// path=Manual). The single [state] StateFlow is OWNED by the IosVoiceAudio facade and
// injected here (spec §7: one state across all engines).
//
// NO-CRASH: every AV call wrapped (runCatching / enginePrepareGuarded /
// engineStartGuarded / memScoped NSError**). Failures become Phase.Error, never a throw
// across @ObjCExport. Sim has no audio route → compile GREEN is the agent gate; device
// run is user-owned. Logs lengths/counts ONLY (PrivacyGuard safe).
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.audioio.enginePrepareGuarded
import io.sentient.mobilesdk.audioio.engineStartGuarded
import io.sentient.mobilesdk.audioio.pcm16ToFloatBuffer
import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.flow.MutableStateFlow
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPlayerNode
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryPlayback
import platform.AVFAudio.AVAudioSessionModeDefault
import platform.AVFAudio.AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
import platform.AVFAudio.setActive
import platform.Foundation.NSError
import kotlin.concurrent.AtomicInt
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase

private const val MONO_CHANNELS = 1u

// Empty AVAudioSessionCategoryOptions set — .playback needs no options (the media route
// is loud by default). The 4-arg setCategory(category, mode, options, error) is the only
// K/N overload that also takes a mode, so pass an empty option set explicitly.
private const val NO_CATEGORY_OPTIONS = 0uL

// Software playback makeup gain applied to the downlink PCM before the player. Even on
// the loud media route the on-host Qwen TTS is quiet (a character trait — not
// normalized). Peaks hard-clamp to [-1,1] in pcm16ToFloatBuffer; ×5.0 will hard-clip
// loud peaks on this route (accepted for the tuning phase, spec §7.2). Mirror of
// DuplexEngine's copy (5.0 on BOTH playback paths) — keep in lockstep. 1.0f = no boost.
private const val PLAYBACK_MAKEUP_GAIN = 5.0f

/**
 * Playback-only engine on a scoped .playback session. [arm] activates the session +
 * attaches the player + starts; [teardown] stops + detaches + deactivates the session
 * (without writing state — the facade owns the resulting idle state). inputNode is
 * NEVER referenced. The single [state] StateFlow is injected by the facade.
 */
internal class MediaPlaybackEngine(
    private val state: MutableStateFlow<VoiceAudioState>,
) {
    private val log = createLogger("voice", "engine", "ios", "media")

    private val engine = AVAudioEngine()
    private val player = AVAudioPlayerNode()

    // Playback drain tracking — outstanding scheduled buffers + generation guard (copied
    // from DuplexEngine). AtomicInt: completion fires on the audio render thread; the
    // counter is read on the orchestrator coroutine.
    private val outstanding = AtomicInt(0)
    private val playbackEpoch = AtomicInt(0)
    private var playerFormat: AVAudioFormat? = null
    private var armed = false

    /** Activate the scoped .playback session, attach + start the player. Idempotent. */
    fun arm(rate: Int) {
        if (armed) {
            log.debug("arm-noop", mapOf("rate" to rate))
            return
        }
        log.info("arm", mapOf("cell" to "(F,T)", "path" to "Manual", "rate" to rate))
        state.value = state.value.copy(phase = Phase.Configuring, micActive = false, playbackActive = true)
        runCatching {
            engine.stop()
            if (!activateSession()) {
                failReset("session-activate-failed")
                return
            }
            attachPlayer(rate)
            if (!ensureRunning()) {
                failReset("engine-start-failed")
                return
            }
            armed = true
        }.onFailure { err ->
            failReset(err.message ?: "unknown")
            return
        }
        state.value = VoiceAudioState(Phase.Ready, micActive = false, playbackActive = true)
    }

    /**
     * Stop + deactivate to a clean idle baseline WITHOUT writing state (the facade owns
     * the resulting idle state after a path switch / shutdown). Idempotent.
     */
    fun teardown() {
        runCatching {
            player.stop()
            if (armed) engine.detachNode(player)
        }.onFailure { log.warn("detach-player-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        runCatching { engine.stop() }
        deactivateSession()
        playerFormat = null
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        armed = false
        log.info("teardown", mapOf("engine" to "media"))
    }

    /**
     * An arm failure: force the engine back to a clean idle baseline (mirrors
     * DuplexEngine.failReset) and set Phase.Error so the SDK lane reconciles to idle and
     * the next arm rebuilds from scratch.
     */
    private fun failReset(reason: String) {
        runCatching { if (armed) { player.stop(); engine.detachNode(player) } }
        runCatching { engine.stop() }
        deactivateSession()
        playerFormat = null
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        armed = false
        state.value = VoiceAudioState(Phase.Error, micActive = false, playbackActive = true, errorReason = reason)
        log.warn("arm-failed", mapOf("reason" to reason))
    }

    /** Scoped .playback + .default (Fish-page pattern). Returns true iff both
     *  setCategory + setActive succeed (matches the Duplex I1 abort). */
    private fun activateSession(): Boolean = memScoped {
        val s = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = s.setCategory(
            AVAudioSessionCategoryPlayback,
            mode = AVAudioSessionModeDefault,
            options = NO_CATEGORY_OPTIONS,
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
        log.debug("session-active", mapOf("category" to "playback", "mode" to "default"))
        true
    }

    private fun deactivateSession() {
        runCatching {
            AVAudioSession.sharedInstance()
                .setActive(false, AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation, null)
        }.onFailure { log.warn("session-deactivate-failed", mapOf("cause" to (it.message ?: "unknown"))) }
    }

    private fun attachPlayer(rate: Int) {
        val format = AVAudioFormat(standardFormatWithSampleRate = rate.toDouble(), channels = MONO_CHANNELS)
        engine.attachNode(player)
        engine.connect(player, to = engine.mainMixerNode, format = format)
        playerFormat = format
        outstanding.value = 0
        playbackEpoch.incrementAndGet()
        log.info("player-attached", mapOf("rate" to rate))
    }

    private fun ensureRunning(): Boolean {
        if (engine.running) return true
        if (!enginePrepareGuarded(engine)) return false
        return engineStartGuarded(engine)
    }

    fun playFrame(pcm16: ByteArray) {
        if (!armed) return
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

    fun flushPlayback() {
        playbackEpoch.incrementAndGet()
        outstanding.value = 0
        runCatching { player.stop() }
            .onFailure { log.warn("flush-playback-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        log.info("flush-playback", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    val isPlaybackIdle: Boolean get() = outstanding.value == 0
}
