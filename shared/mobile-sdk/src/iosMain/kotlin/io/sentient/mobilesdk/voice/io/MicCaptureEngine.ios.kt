// ---------------------------------------------------------------------------
// MicCaptureEngine.ios.kt — capture-only AVAudioEngine for the Manual (hold) mic path.
//
// Input tap → 16k PCM16 → the facade's single micFrames channel (drop-newest, cap 16),
// MIC_CAPTURE_GAIN + capture-level meter log — mirrors today's DuplexEngine tap code
// MINUS the duplex machinery (no player, no output mixer, NO VPIO ever). Because hold
// mode never plays TTS while the mic is live (press interrupts TTS before capture arms),
// there is no echo to cancel, so voice-processing (VPIO) is deliberately absent.
//
// Scoped session: .playAndRecord + .default mode + defaultToSpeaker option, activate on
// arm, setActive(false, notifyOthersOnDeactivation) on teardown (Fish-page pattern,
// proven in this app via VoiceSamplePlayer/VoiceRecorder). Used for (mic=T, playback=F,
// path=Manual). The single [state] StateFlow + [micCh] channel are OWNED by the
// IosVoiceAudio facade and injected here (spec §7: one state + one micFrames).
//
// NO-CRASH: every AV call wrapped (runCatching / enginePrepareGuarded /
// engineStartGuarded / memScoped NSError**). Failures become Phase.Error, never a throw
// across @ObjCExport. Sim has no mic → compile GREEN is the agent gate; device mic run
// is user-owned. Logs lengths/counts ONLY (PrivacyGuard safe).
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.audio.pcm16LeToShorts
import io.sentient.mobilesdk.audioio.enginePrepareGuarded
import io.sentient.mobilesdk.audioio.engineStartGuarded
import io.sentient.mobilesdk.audioio.Pcm16Converter
import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryOptionDefaultToSpeaker
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionModeDefault
import platform.AVFAudio.AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
import platform.AVFAudio.setActive
import platform.Foundation.NSError
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase

private const val TARGET_SAMPLE_RATE_HZ = 16_000
private const val INPUT_BUS = 0uL
private const val TAP_BUFFER_FRAMES = 1024u

// Software mic gain applied to captured PCM16 in the tap. iOS delivers far-field speech
// quiet, so we boost deterministically here. ×4.25; tune from the "capture-level" log.
// Mirror of DuplexEngine's copy (spec §7.2: MIC_CAPTURE_GAIN stays 4.25 on BOTH capture
// paths) — keep in lockstep. 1.0f = no boost.
private const val MIC_CAPTURE_GAIN = 4.25f
// Throttle the capture-level meter log — the tap fires ~10×/s, so every 50 ≈ 5s.
private const val METER_LOG_EVERY = 50

/**
 * Capture-only engine on a scoped .playAndRecord + .default session, NO VPIO. [arm]
 * activates the session + installs the tap + starts; [teardown] stops + removes the tap
 * + deactivates the session (without writing state — the facade owns the resulting idle
 * state). No player, no output mixer. The single [state] StateFlow + [micCh] channel are
 * injected by the facade.
 */
internal class MicCaptureEngine(
    private val state: MutableStateFlow<VoiceAudioState>,
    private val micCh: Channel<ShortArray>,
) {
    private val log = createLogger("voice", "engine", "ios", "capture")

    private val engine = AVAudioEngine()

    private var converter: Pcm16Converter? = null
    private var capturedCount = 0
    private var droppedCount = 0
    private var armed = false

    /** Activate the scoped .playAndRecord session, install the tap + start. Idempotent. */
    fun arm() {
        if (armed) {
            log.debug("arm-noop", emptyMap())
            return
        }
        log.info("arm", mapOf("cell" to "(T,F)", "path" to "Manual", "vpio" to false))
        state.value = state.value.copy(phase = Phase.Configuring, micActive = true, playbackActive = false)
        runCatching {
            engine.stop()
            if (!activateSession()) {
                failReset("session-activate-failed")
                return
            }
            installTap()
            if (!ensureRunning()) {
                failReset("engine-start-failed")
                return
            }
            armed = true
        }.onFailure { err ->
            failReset(err.message ?: "unknown")
            return
        }
        state.value = VoiceAudioState(Phase.Ready, micActive = true, playbackActive = false)
    }

    /**
     * Stop + remove tap + deactivate to a clean idle baseline WITHOUT writing state (the
     * facade owns the resulting idle state after a path switch / shutdown). Idempotent.
     */
    fun teardown() {
        runCatching { engine.stop() }
        runCatching { engine.inputNode.removeTapOnBus(INPUT_BUS) }
        deactivateSession()
        converter = null
        armed = false
        log.info("teardown", mapOf("captured" to capturedCount, "dropped" to droppedCount))
    }

    /**
     * An arm failure: force the engine back to a clean idle baseline (mirrors
     * DuplexEngine.failReset) and set Phase.Error so the SDK lane reconciles to idle and
     * the next arm rebuilds from scratch.
     */
    private fun failReset(reason: String) {
        runCatching { engine.stop() }
        runCatching { engine.inputNode.removeTapOnBus(INPUT_BUS) }
        deactivateSession()
        converter = null
        armed = false
        state.value = VoiceAudioState(Phase.Error, micActive = true, playbackActive = false, errorReason = reason)
        log.warn("arm-failed", mapOf("reason" to reason))
    }

    /** Scoped .playAndRecord + .default + defaultToSpeaker, NO VPIO, NO speaker override
     *  (capture-only — there is no output route). Returns true iff both setCategory +
     *  setActive succeed (matches the Duplex I1 abort). */
    private fun activateSession(): Boolean = memScoped {
        val s = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = s.setCategory(
            AVAudioSessionCategoryPlayAndRecord,
            mode = AVAudioSessionModeDefault,
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
        log.debug("session-active", mapOf("category" to "playAndRecord", "mode" to "default", "vpio" to false))
        true
    }

    private fun deactivateSession() {
        runCatching {
            AVAudioSession.sharedInstance()
                .setActive(false, AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation, null)
        }.onFailure { log.warn("session-deactivate-failed", mapOf("cause" to (it.message ?: "unknown"))) }
    }

    private fun ensureRunning(): Boolean {
        if (engine.running) return true
        if (!enginePrepareGuarded(engine)) return false
        return engineStartGuarded(engine)
    }

    // ── Mic tap (48k→16k convert-in-tap, drop-newest) — capture-only, no output. ──────
    private fun installTap() {
        val input = engine.inputNode
        val inputFormat = input.inputFormatForBus(INPUT_BUS)
        if (inputFormat.sampleRate <= 0.0 || inputFormat.channelCount <= 0u) {
            // Throw so the outer runCatching in arm() catches it → failReset → Phase.Error
            // (silent return would leave a cold micFrames + Phase.Ready → uplink dead).
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
        log.debug("tap-installed", mapOf("inputRate" to inputFormat.sampleRate, "targetRate" to TARGET_SAMPLE_RATE_HZ))
        converter = conv
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

    /** Log the RAW capture RMS (throttled — for gain tuning), then apply MIC_CAPTURE_GAIN
     *  in-place, clamped to Int16. rmsRaw is an aggregate energy level, not content. */
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

    private companion object {
        // Dropped-frame WARN throttle: warn on the first drop + every Nth after.
        const val DROP_WARN_EVERY = 50
    }
}
