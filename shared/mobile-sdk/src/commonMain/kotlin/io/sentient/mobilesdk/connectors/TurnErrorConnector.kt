// ---------------------------------------------------------------------------
// TurnErrorConnector — classifies an UNSOLICITED turn.aborted as a recoverable
// error, distinguishing it from a client-initiated abort (UI Stop / barge-in).
//
// Extension BEYOND web-sdk: web-sdk's connectors treat every turn.aborted the
// same (return cognition to idle + clear the in-flight buffer). The mobile
// client needs a recoverable-error surface so a wire-death mid-turn (which
// yields NO answer and NO indication today) is visible to the native UI. This
// connector adds that one extra discrimination; it does NOT change the existing
// cognition / in-flight handling (those stay on their own connectors).
//
// WHY a connector (not the deriver): the classification is an FSM over turn
// lifecycle frames PLUS two client-side signals the orchestrator owns:
//   - interrupt()  (UI Stop) — a ClientMessage, never a ServerMessage, so the
//     orchestrator must push it in via noteInterrupt(turnId).
//   - barge-in onset — detected in the AudioPipeline, pushed in via
//     noteBargeIn(turnId) through an orchestrator callback.
// The orchestrator wires both, mirroring how it already fans connector
// callbacks into the single StateDeriver.
//
// CLASSIFICATION (design §4.7 CutoffKind):
//   turn.aborted cutoff="interrupt" → user-cancel / session-switch — self-init.
//   turn.aborted cutoff="barge-in"  → mic onset cut the reply — self-initiated.
//
// PRIMARY signal is client-side self-initiation (not `cutoff`): the SDK contract
// must classify a bare turn.aborted (cutoff absent / degraded frame) as an error
// when the client did nothing. `cutoff` is corroboration only.
//
// An abort is an ERROR iff, for the active turn:
//   - the client did NOT interrupt() it,             AND
//   - no barge-in onset fired for it,                AND
//   - it produced no committed assistant content
//     (no turn.completed seen — a completed-then-aborted ReAct continuation is
//      a success, not an error).
//
// Cleared on: turn.started (next turn), turn.completed (success), and reset()
// (newChat / switchSession, driven by the orchestrator).
//
// Threading: single-threaded; the orchestrator routes frames + the two notes on
// one dispatcher and subscribes onErrorChange. The mutable state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

class TurnErrorConnector(
    private val onErrorChange: ((Boolean) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "turn-error")

    /** turnId of the active turn, or null when none is in flight. */
    private var activeTurnId: String? = null

    /** True once the client self-initiated an abort (interrupt / barge-in) for [activeTurnId]. */
    private var selfInitiated: Boolean = false

    /** True once a successful terminal (turn.completed) committed content for [activeTurnId]. */
    private var sawDone: Boolean = false

    /** The surfaced error flag — true only on an unsolicited abort, until the next turn/reset. */
    private var lastError: Boolean = false

    /** Current unsolicited-error flag. */
    fun hasError(): Boolean = lastError

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> onTurnStarted(msg.turnId)
            is ServerMessage.TurnCompleted -> onSuccess(msg.turnId, "turn.completed")
            is ServerMessage.TurnAborted -> onAborted(msg.turnId, msg.cutoff)
            else -> Unit // not owned by this connector
        }
    }

    /** UI Stop / Escape for [turnId]: mark the active turn's abort as self-initiated. */
    fun noteInterrupt(turnId: String?) = noteSelfInitiated(turnId, "interrupt")

    /** Mic-onset barge-in for [turnId]: mark the active turn's abort as self-initiated. */
    fun noteBargeIn(turnId: String?) = noteSelfInitiated(turnId, "barge-in")

    /** Drop all per-turn tracking + clear the error flag. Driven on newChat / switchSession. */
    fun reset() {
        activeTurnId = null
        selfInitiated = false
        sawDone = false
        clearError("reset")
    }

    private fun onTurnStarted(turnId: String) {
        activeTurnId = turnId
        selfInitiated = false
        sawDone = false
        clearError("turn.started")
    }

    private fun onSuccess(turnId: String?, trigger: String) {
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        sawDone = true
        clearError(trigger)
    }

    private fun noteSelfInitiated(turnId: String?, gesture: String) {
        // A null turnId (no active turn on the gateway) still arms the latch: interrupt()
        // is sent with whatever turn is live, and a same-turn abort following it must be
        // classified self-initiated. Only ignore a note targeting a DIFFERENT turn.
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        selfInitiated = true
        log.info("note", mapOf("gesture" to gesture, "turnId" to (turnId ?: activeTurnId)))
    }

    private fun onAborted(turnId: String?, cutoff: String) {
        if (turnId != null && activeTurnId != null && turnId != activeTurnId) return
        val unsolicited = !selfInitiated && !sawDone
        val resolvedTurnId = turnId ?: activeTurnId
        log.info(
            "classify",
            mapOf(
                "turnId" to resolvedTurnId,
                "cutoff" to cutoff,
                "selfInitiated" to selfInitiated,
                "sawDone" to sawDone,
                "verdict" to if (unsolicited) "unsolicited(error)" else "self-initiated",
            ),
        )
        if (resolvedTurnId != null) onEvent?.invoke(SdkEvent.TurnAborted(turnId = resolvedTurnId, cutoff = cutoff))
        activeTurnId = null
        if (unsolicited) setError() else clearError("self-initiated-abort")
    }

    private fun setError() {
        if (lastError) return
        lastError = true
        onErrorChange?.invoke(true)
    }

    private fun clearError(trigger: String) {
        if (!lastError) return
        log.info("clear", mapOf("trigger" to trigger))
        lastError = false
        onErrorChange?.invoke(false)
    }

    companion object {
        const val CAPABILITY: String = "turn.error"
    }
}
