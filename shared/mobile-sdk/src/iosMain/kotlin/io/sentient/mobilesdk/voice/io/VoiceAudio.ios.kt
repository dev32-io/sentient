// ---------------------------------------------------------------------------
// VoiceAudio.ios.kt — path-routing facade over THREE separate iOS audio engines.
//
// iOS session transitions are HAUNTED: a per-cell .playback↔.playAndRecord category
// switch on ONE shared engine was tried twice and both times killed audio (git 2633b4e
// + a re-confirmed 2026-07-17 attempt). Root structural cause: an engine whose inputNode
// was ever touched starts DEAD under .playback. The fix design is THREE fully separate
// engines, each with its own scoped session, NEVER running concurrently:
//
//   - DuplexEngine     — the original one-AVAudioEngine machinery, byte-for-byte
//                        (.playAndRecord+.videoChat, VPIO iff mic+playback, tap reinstall,
//                        gains, failReset, drain counters). Used for ALL cells when
//                        path == Duplex (the Continuous / full-duplex path).
//   - MediaPlaybackEngine — playback-only, scoped .playback session, NEVER touches
//                        inputNode. Used for (mic=F, playback=T, path=Manual).
//   - MicCaptureEngine — capture-only, scoped .playAndRecord+.default, NO VPIO. Used for
//                        (mic=T, playback=F, path=Manual).
//
// EXCLUSIVITY is the load-bearing invariant: at most ONE engine (⇒ one live AVAudioSession)
// at a time. Before starting a new engine the facade FULLY tears down whichever other
// engine is live (stop engine → remove tap / detach player → setActive(false)), so every
// transition crosses a dead-audio boundary + a full session deactivate — guaranteed by
// the TalkMode UX (press interrupts TTS before any switch; replies only start after
// release), NOT by timing tricks.
//
// The facade OWNS the single [state] StateFlow + the single [micCh]/[micFrames] channel
// (spec §7: one state + one micFrames across all engines) and injects them into each
// engine. The 3-arg legacy configure delegates with path=Duplex (unchanged behavior for
// any caller not yet threading path).
//
// NO-CRASH: every AV call inside the engines is guarded; the facade never throws across
// @ObjCExport. Compile GREEN is the agent gate (sim has no mic/audio route); the device
// hold-basic + round-trip-stability gate is user-owned. Logs lengths/counts/ids ONLY.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.voice.io

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.BetaInteropApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import io.sentient.mobilesdk.voice.io.VoiceAudioState.Phase

// Bounded mic channel capacity (drop-newest via trySend). Owned by the facade; both the
// Duplex and MicCapture engines feed this ONE channel.
private const val FRAME_CHANNEL_CAPACITY = 16

/**
 * The single [VoiceAudio] surface for iOS, routing each (mic, playback, path) cell to
 * exactly one of three internal engines and enforcing one-live-session exclusivity.
 * See the file header for the engine roster + the haunted-transition history.
 */
class IosVoiceAudio : VoiceAudio {
    private val log = createLogger("voice", "engine", "ios", "facade")

    private val _state = MutableStateFlow(VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false))
    override val state: StateFlow<VoiceAudioState> = _state

    // Bounded SUSPEND channel; drop-newest via trySend. The ONE micFrames flow across all
    // engines — both Duplex and MicCapture feed it.
    private val micCh = Channel<ShortArray>(capacity = FRAME_CHANNEL_CAPACITY)
    override val micFrames: Flow<ShortArray> = micCh.receiveAsFlow()
    private val _micLevels = MutableStateFlow(MicLevelEnvelope.silence())
    override val micLevels: StateFlow<MicLevelEnvelope> = _micLevels
    private val meter = MicLevelMeter { _micLevels.value = it }

    // The three path-split engines. Each feeds the shared _state / micCh.
    private val duplex = DuplexEngine(_state, micCh, meter)
    private val media = MediaPlaybackEngine(_state)
    private val capture = MicCaptureEngine(_state, micCh, meter)

    // Which engine currently holds the live session. Advanced only inside configure().
    private var active = EngineKind.Idle

    private enum class EngineKind { Idle, Duplex, Media, Capture }

    override suspend fun configure(mic: Boolean, playback: Boolean, playbackRateHz: Int) =
        configure(mic, playback, VoiceAudioPath.Duplex, playbackRateHz)

    override suspend fun configure(mic: Boolean, playback: Boolean, path: VoiceAudioPath, playbackRateHz: Int) {
        val target = route(mic, playback, path)
        log.info(
            "route",
            mapOf("mic" to mic, "playback" to playback, "path" to path.name, "from" to active.name, "to" to target.name),
        )
        if (target == EngineKind.Idle) {
            goIdle(playbackRateHz)
            return
        }
        // EXCLUSIVITY: fully tear down whichever OTHER engine is live before starting the
        // target (one live session at a time; always transition through silence).
        if (active != target) {
            teardownActive()
            active = EngineKind.Idle
        }
        when (target) {
            EngineKind.Duplex -> duplex.configure(mic, playback, playbackRateHz)
            EngineKind.Media -> media.arm(playbackRateHz)
            EngineKind.Capture -> capture.arm()
            EngineKind.Idle -> Unit // unreachable (handled above)
        }
        // On a failure the engine self-reset to idle baseline + set Phase.Error (SdkVoice
        // reconciles its lane to idle on Error). Mirror that: mark the facade Idle so the
        // next configure re-attempts from scratch rather than diffing against a dead engine.
        active = if (_state.value.phase == Phase.Error) EngineKind.Idle else target
    }

    /**
     * Route a (mic, playback, path) cell to the owning engine. Only (mic=T, playback=F)
     * is path-ambiguous (Hold=Capture vs Continuous=Duplex mic-only); every other cell is
     * unambiguous. (mic=T, playback=T, Manual) should NEVER occur (TalkModeController
     * never produces it) — WARN + route to Duplex (defensive, never crash).
     */
    private fun route(mic: Boolean, playback: Boolean, path: VoiceAudioPath): EngineKind {
        if (!mic && !playback) return EngineKind.Idle
        if (path == VoiceAudioPath.Duplex) return EngineKind.Duplex
        // path == Manual
        return when {
            mic && !playback -> EngineKind.Capture
            !mic && playback -> EngineKind.Media
            else -> {
                log.warn(
                    "route-unexpected-manual-duplex-cell",
                    mapOf("mic" to mic, "playback" to playback, "action" to "route-to-duplex"),
                )
                EngineKind.Duplex
            }
        }
    }

    /**
     * Transition to idle. Coming from Duplex we delegate to duplex.configure(false, false)
     * so the Continuous→Idle teardown is BYTE-IDENTICAL to today (its own session
     * deactivate + Phase.Ready(false,false)). Coming from Media/Capture we tear the engine
     * down and set the same idle baseline the facade owns. From Idle it is a duplex no-op
     * (matching today's repeated (F,F) configure-noop log).
     */
    private suspend fun goIdle(rate: Int) {
        when (active) {
            EngineKind.Duplex, EngineKind.Idle -> duplex.configure(false, false, rate)
            EngineKind.Media -> {
                media.teardown()
                _state.value = VoiceAudioState(Phase.Ready, micActive = false, playbackActive = false)
            }
            EngineKind.Capture -> {
                capture.teardown()
                _state.value = VoiceAudioState(Phase.Ready, micActive = false, playbackActive = false)
            }
        }
        active = EngineKind.Idle
    }

    /** Fully stop + deactivate whichever engine currently holds the live session. */
    private fun teardownActive() {
        when (active) {
            EngineKind.Duplex -> duplex.teardown()
            EngineKind.Media -> media.teardown()
            EngineKind.Capture -> capture.teardown()
            EngineKind.Idle -> Unit
        }
    }

    // ── Downlink sink: route to whichever engine currently owns playback ──────────
    override fun playFrame(pcm16: ByteArray) {
        when (active) {
            EngineKind.Duplex -> duplex.playFrame(pcm16)
            EngineKind.Media -> media.playFrame(pcm16)
            EngineKind.Capture, EngineKind.Idle -> Unit // no player armed → drop (matches today's null-player guard)
        }
    }

    override fun flushPlayback() {
        when (active) {
            EngineKind.Duplex -> duplex.flushPlayback()
            EngineKind.Media -> media.flushPlayback()
            EngineKind.Capture, EngineKind.Idle -> Unit // nothing playing
        }
    }

    override val isPlaybackIdle: Boolean
        get() = when (active) {
            EngineKind.Duplex -> duplex.isPlaybackIdle
            EngineKind.Media -> media.isPlaybackIdle
            EngineKind.Capture, EngineKind.Idle -> true // no player → drained
        }

    override suspend fun shutdown() {
        log.info("shutdown", mapOf("active" to active.name))
        duplex.teardown()
        media.teardown()
        capture.teardown()
        active = EngineKind.Idle
        micCh.close()
        meter.reset()
        _state.value = VoiceAudioState(Phase.Idle, micActive = false, playbackActive = false)
    }
}
