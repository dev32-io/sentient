// ---------------------------------------------------------------------------
// TalkModeController — the encapsulated mode brain (design spec §3).
//
// Owns the TalkMode FSM (Idle | Hold | Continuous). The UI drives it through INTENTS
// only (pressMic / releaseMic / lockMic / stopContinuous) — a stable contract for the
// coming gesture-layer redesign. All mode semantics (interrupt-on-press, turnMode on
// audio.start, buffer-and-defer on hold, back-to-back end+start on lock) live HERE, not
// in the UI or the gesture translator.
//
// The controller is transport-agnostic: it drives injected SEAMS (lambda house-style,
// mirroring SdkVoice.onUplinkStart / AudioPipeline.armPlayback), never touching the WS,
// the engine, or the connectors directly. This keeps it pure commonMain + unit-testable
// against fakes (commonMain-purity rule) and lets the platform slices (S4/S5) + the UI
// wiring slice (S6) supply the real implementations:
//
//   startCapture(turnMode)  → SdkVoice.requestStart(turnMode): audio.start(turnMode) + mic on
//   endCapture()            → SdkVoice.requestStop():          audio.end + mic off
//   interrupt()             → SentientSdk.interrupt():         abort cycle + TTS + flush playback
//   isCycleOrTtsActive()    → deriver.cognition != IDLE || deriver.isSpeaking
//   beginHoldDefer()        → AudioPipeline.beginHold():       downlink buffers, never arms
//   endHoldDefer()          → AudioPipeline.endHold():         arm playback + flush buffer in order
//
// Illegal intents (an intent not defined from the current state) are a logged WARN + no-op
// — NEVER a throw across the boundary (error-handling + coroutines-flow-surface rules).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.talk

import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The talk-mode FSM + intent surface.
 *
 * @param startCapture Opens the uplink for a turn: `audio.start(turnMode)` + mic capture ON,
 *   via the serialized configure lane. [TurnMode.Manual] on Hold entry, [TurnMode.Semantic]
 *   on Continuous entry.
 * @param endCapture Closes the uplink: `audio.end` + mic capture OFF. On the gateway this
 *   flushes STT so the (manual) turn finalizes.
 * @param interrupt Hard interrupt — abort the active cycle + TTS + flush playback. Reuses the
 *   SDK's existing interrupt surface (never a new frame). Fired ONLY from Idle→Hold and ONLY
 *   when a cycle/TTS is actually active (press IS the barge-in).
 * @param isCycleOrTtsActive True iff a cognitive cycle is running OR TTS is currently playing.
 *   Gates the press-interrupt so an idle press never sends a spurious interrupt.
 * @param beginHoldDefer Enter Hold buffering: downlink TTS must NOT arm playback; frames
 *   accumulate in the bounded pre-arm buffer and flush on [endHoldDefer].
 * @param endHoldDefer Exit Hold buffering: arm playback + flush the deferred buffer in order,
 *   then continue live. From commonMain's view release AND lock are both "arm + flush"; the
 *   platform actual selects the media vs duplex path from the (mic, playback) cell.
 * @param log Tagged logger; defaults to the `sentient.mobile-sdk.voice.talk-mode` tag.
 */
class TalkModeController(
    private val startCapture: (TurnMode) -> Unit,
    private val endCapture: () -> Unit,
    private val cancelCapture: () -> Unit = endCapture,
    private val interrupt: () -> Unit,
    private val isCycleOrTtsActive: () -> Boolean,
    private val beginHoldDefer: () -> Unit,
    private val endHoldDefer: () -> Unit,
    private val discardHoldDefer: () -> Unit = endHoldDefer,
    private val log: Log = createLogger("voice", "talk-mode"),
) {
    private val _mode = MutableStateFlow(TalkMode.Idle)

    /** Current talk mode. Hot StateFlow (conflation fine — latest wins) per the SDK's split
     *  observable-surface convention. The UI renders the corner-mic affordance off this. */
    val mode: StateFlow<TalkMode> = _mode.asStateFlow()

    /**
     * Idle → Hold. Press IS the barge-in: interrupt any active reply, then open the manual
     * turn. Enters the hold defer BEFORE capture so any proactive TTS during the hold buffers
     * (never plays) from the first mic frame.
     */
    fun pressMic() {
        val from = _mode.value
        if (from != TalkMode.Idle) return illegal("pressMic", from)
        if (isCycleOrTtsActive()) {
            log.info("talk-mode.press-interrupt", mapOf("from" to from.name))
            interrupt()
        }
        beginHoldDefer()
        startCapture(TurnMode.Manual)
        commit(from, TalkMode.Hold, "pressMic")
    }

    /**
     * Hold → Idle. Release finalizes the manual turn (`audio.end` → gateway flushes STT),
     * turns capture off, then arms media playback + flushes any deferred TTS buffer.
     */
    fun releaseMic() {
        val from = _mode.value
        if (from != TalkMode.Hold) return illegal("releaseMic", from)
        endCapture()
        endHoldDefer()
        commit(from, TalkMode.Idle, "releaseMic")
    }

    /** Hold → Idle without submitting speech or restoring deferred assistant audio. */
    fun cancelHeld() {
        val from = _mode.value
        if (from != TalkMode.Hold) return illegal("cancelHeld", from)
        cancelCapture()
        discardHoldDefer()
        commit(from, TalkMode.Idle, "cancelHeld")
    }

    /**
     * Hold → Continuous. Lock finalizes the manual segment and re-opens as a semantic turn
     * back-to-back (`audio.end` + `audio.start(turnMode=semantic)`); frames keep flowing. The
     * deferred buffer flushes into the (now duplex) playback path — commonMain just arms+flushes.
     */
    fun lockMic() {
        val from = _mode.value
        if (from != TalkMode.Hold) return illegal("lockMic", from)
        endCapture()
        startCapture(TurnMode.Semantic)
        endHoldDefer()
        commit(from, TalkMode.Continuous, "lockMic")
    }

    /** Continuous → Idle. Ends the semantic turn (`audio.end`); the duplex path drains + tears down. */
    fun stopContinuous() {
        val from = _mode.value
        if (from != TalkMode.Continuous) return illegal("stopContinuous", from)
        endCapture()
        commit(from, TalkMode.Idle, "stopContinuous")
    }

    /**
     * Reset capture ownership after a genuine shared audio failure or teardown.
     * This is deliberately separate from [releaseMic]: the capture is already gone,
     * so emitting another stop would duplicate the release intent. Idempotence also
     * makes repeated Error/Idle projections harmless.
     */
    fun captureLost(reason: String) {
        val from = _mode.value
        if (from == TalkMode.Idle) return
        commit(from, TalkMode.Idle, "captureLost:$reason")
    }

    /** Public iOS-facing names; legacy Android callbacks remain aliases below them. */
    fun holdStart() = pressMic()
    fun sendHeld() = releaseMic()
    fun enterAuto() = lockMic()
    fun exitAuto() = stopContinuous()

    /** Permission/view/session/SDK teardown: cancel user capture, never assistant work. */
    fun lifecycleCancel(reason: String) {
        val from = _mode.value
        if (from == TalkMode.Idle) return
        cancelCapture()
        if (from == TalkMode.Hold) discardHoldDefer()
        commit(from, TalkMode.Idle, "lifecycleCancel:$reason")
    }

    private fun commit(from: TalkMode, to: TalkMode, trigger: String) {
        _mode.value = to
        log.info("talk-mode", mapOf("from" to from.name, "to" to to.name, "trigger" to trigger))
    }

    private fun illegal(intent: String, from: TalkMode) {
        log.warn("talk-mode.illegal-intent", mapOf("intent" to intent, "from" to from.name, "reason" to "no-op"))
    }
}
