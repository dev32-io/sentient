// ---------------------------------------------------------------------------
// CycleErrorConnector — classifies an UNSOLICITED cycle.aborted as a recoverable
// error, distinguishing it from a client-initiated abort (UI Stop / barge-in).
//
// Extension BEYOND web-sdk: web-sdk's connectors treat every cycle.aborted the
// same (return cognition to idle + clear the in-flight buffer). The mobile
// client needs a recoverable-error surface so a wire-death mid-cycle (which
// yields NO answer and NO indication today) is visible to the native UI. This
// connector adds that one extra discrimination; it does NOT change the existing
// cognition / in-flight handling (those stay on their own connectors).
//
// WHY a connector (not the deriver): the classification is an FSM over cycle
// lifecycle frames PLUS two client-side signals the orchestrator owns:
//   - interrupt()  (UI Stop) — a ClientMessage, never a ServerMessage, so the
//     orchestrator must push it in via noteInterrupt(cycleId).
//   - barge-in onset — detected in the AudioPipeline, pushed in via
//     noteBargeIn(cycleId) through an orchestrator callback.
// The orchestrator wires both, mirroring how it already fans connector
// callbacks into the single StateDeriver.
//
// CLASSIFICATION (gateway Step-0 findings, hermes-event-translator.ts):
//   cycle.aborted reason="error"     → wire/server error (sawError) — UNSOLICITED.
//   cycle.aborted reason="interrupt" → user-cancel / session-switch — self-init.
//   barge-in                         → NO cycle.aborted on the gateway (the cycle
//                                      SURVIVES a barge-in per spec v4 §5.9; only
//                                      TTS is cut). Tracked anyway as a defensive
//                                      suppressor in case a future abort races it.
//
// PRIMARY signal is client-side self-initiation (not `reason`): the SDK contract
// must classify a bare cycle.aborted (reason absent / older gateway) as an error
// when the client did nothing. `reason == "error"` is corroboration only.
//
// An abort is an ERROR iff, for the active cycle:
//   - the client did NOT interrupt() it,             AND
//   - no barge-in onset fired for it,                AND
//   - it produced no committed assistant content
//     (no message.done seen — a completed-then-aborted ReAct continuation is
//      a success, not an error).
//
// Cleared on: cycle.started (next cycle), message.done / cycle.completed
// (success), and reset() (newChat / switchSession, driven by the orchestrator).
//
// Threading: single-threaded; the orchestrator routes frames + the two notes on
// one dispatcher and subscribes onErrorChange. The mutable state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

class CycleErrorConnector(
    private val onErrorChange: ((Boolean) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "cycle-error")

    /** cycleId of the active cycle, or null when none is in flight. */
    private var activeCycleId: String? = null

    /** True once the client self-initiated an abort (interrupt / barge-in) for [activeCycleId]. */
    private var selfInitiated: Boolean = false

    /** True once a successful terminal (message.done) committed content for [activeCycleId]. */
    private var sawDone: Boolean = false

    /** The surfaced error flag — true only on an unsolicited abort, until the next cycle/reset. */
    private var lastError: Boolean = false

    /** Current unsolicited-error flag. */
    fun hasError(): Boolean = lastError

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.CycleStarted -> onCycleStarted(msg.cycleId)
            is ServerMessage.MessageDone -> onSuccess(msg.cycleId, "message.done")
            is ServerMessage.CycleCompleted -> onSuccess(msg.cycleId, "cycle.completed")
            is ServerMessage.CycleAborted -> onAborted(msg.cycleId, msg.reason)
            else -> Unit // not owned by this connector
        }
    }

    /** UI Stop / Escape for [cycleId]: mark the active cycle's abort as self-initiated. */
    fun noteInterrupt(cycleId: String?) = noteSelfInitiated(cycleId, "interrupt")

    /** Mic-onset barge-in for [cycleId]: mark the active cycle's abort as self-initiated. */
    fun noteBargeIn(cycleId: String?) = noteSelfInitiated(cycleId, "barge-in")

    /** Drop all per-cycle tracking + clear the error flag. Driven on newChat / switchSession. */
    fun reset() {
        activeCycleId = null
        selfInitiated = false
        sawDone = false
        clearError("reset")
    }

    private fun onCycleStarted(cycleId: String) {
        activeCycleId = cycleId
        selfInitiated = false
        sawDone = false
        clearError("cycle.started")
    }

    private fun onSuccess(cycleId: String?, trigger: String) {
        if (cycleId != null && activeCycleId != null && cycleId != activeCycleId) return
        sawDone = true
        clearError(trigger)
    }

    private fun noteSelfInitiated(cycleId: String?, gesture: String) {
        // A null cycleId (no active cycle on the gateway) still arms the latch:
        // interrupt() is sent with whatever cycle is live, and a same-cycle abort
        // following it must be classified self-initiated. Only ignore a note that
        // explicitly targets a DIFFERENT cycle than the one in flight.
        if (cycleId != null && activeCycleId != null && cycleId != activeCycleId) return
        selfInitiated = true
        log.info("note", mapOf("gesture" to gesture, "cycleId" to (cycleId ?: activeCycleId)))
    }

    private fun onAborted(cycleId: String?, reason: String?) {
        if (cycleId != null && activeCycleId != null && cycleId != activeCycleId) return
        val unsolicited = !selfInitiated && !sawDone
        val resolvedCycleId = cycleId ?: activeCycleId
        log.info(
            "classify",
            mapOf(
                "cycleId" to resolvedCycleId,
                "reason" to reason,
                "selfInitiated" to selfInitiated,
                "sawDone" to sawDone,
                "verdict" to if (unsolicited) "unsolicited(error)" else "self-initiated",
            ),
        )
        if (resolvedCycleId != null) {
            onEvent?.invoke(SdkEvent.CycleAborted(cycleId = resolvedCycleId, kind = reason))
        }
        activeCycleId = null
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
        const val CAPABILITY: String = "cycle.error"
    }
}
