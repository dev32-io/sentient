// ---------------------------------------------------------------------------
// CognitionStatusConnector — tracks cognition cycle lifecycle.
//
// Mirrors web-sdk's cognition-status-connector.ts VERBATIM:
//   capability = "cognition.status"  (status observer)
//
//   cycle.started   → THINKING
//   cycle.completed → IDLE
//   cycle.aborted   → IDLE
//   (duplicate target state → no callback; setState short-circuits)
//
// NOTE — three states, two reached: the TS declares CognitionState =
// idle | thinking | acting, but the cognition-status-connector NEVER drives
// "acting" — it is reserved for a separate task-driven surface. We port the
// enum verbatim (IDLE/THINKING/ACTING) and the exact idle↔thinking table; the
// ACTING branch is unreached here, matching the TS. (Plan summary lists only
// the three cycle.* transitions — confirmed against the TS, no extra
// transitions exist in this connector.)
//
// Threading: single-threaded; the orchestrator routes frames and subscribes
// onStateChange. The mutable state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

/** Simplified client-side cognition state. Mirrors web-sdk CognitionState. */
enum class CognitionState {
    IDLE,
    THINKING,
    ACTING,
}

class CognitionStatusConnector(
    private val onStateChange: ((CognitionState) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "cognition-status")

    private var currentState: CognitionState = CognitionState.IDLE

    /** Current cognition state. */
    fun state(): CognitionState = currentState

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.CycleStarted -> setState(CognitionState.THINKING, "cycle.started", msg.cycleId)
            is ServerMessage.CycleCompleted -> {
                setState(CognitionState.IDLE, "cycle.completed", msg.cycleId)
                onEvent?.invoke(SdkEvent.CycleDone(cycleId = msg.cycleId))
            }
            is ServerMessage.CycleAborted -> setState(CognitionState.IDLE, "cycle.aborted", msg.cycleId)
            else -> Unit // not owned by this connector
        }
    }

    /** Force-reset to IDLE (optimistic local clear). Fires onStateChange via setState so the
     *  orchestrator's deriver stays in sync; prevents the next cycle.started short-circuiting. */
    fun reset() = setState(CognitionState.IDLE, "reset", null)

    private fun setState(next: CognitionState, trigger: String, cycleId: String?) {
        if (next == currentState) return
        log.info(
            "transition",
            mapOf("from" to currentState, "to" to next, "trigger" to trigger, "cycleId" to cycleId),
        )
        currentState = next
        onStateChange?.invoke(next)
    }

    companion object {
        const val CAPABILITY: String = "cognition.status"
    }
}
