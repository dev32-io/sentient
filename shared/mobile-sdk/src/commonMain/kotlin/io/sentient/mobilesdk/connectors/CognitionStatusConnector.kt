// ---------------------------------------------------------------------------
// CognitionStatusConnector — tracks turn lifecycle (design §7).
//
// Mirrors web-sdk's cognition-status connector state, retaining turn identity for
// overlapping turns:
//   capability = "cognition.status"  (status observer)
//
//   turn.started   → global THINKING; newest turn owns presentation
//   turn.completed → global IDLE; clears presentation only when it closes that owner
//   turn.aborted   → global IDLE; clears presentation only when it closes that owner
//   (older overlapping turns never reclaim presentation; global callbacks retain web parity)
//
// NOTE — three states, two reached: the TS declares CognitionState =
// idle | thinking | acting, but the cognition-status-connector NEVER drives
// "acting" — it is reserved for a separate task-driven surface. We port the
// enum verbatim (IDLE/THINKING/ACTING) and the exact idle↔thinking table; the
// ACTING branch is unreached here, matching the TS. (Plan summary lists only
// the three turn.* transitions — confirmed against the TS, no extra
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
    private val onActivityChange: ((CognitionState, String?) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "cognition-status")

    private var currentState: CognitionState = CognitionState.IDLE
    private var activityTurnId: String? = null

    /** Current cognition state. */
    fun state(): CognitionState = currentState

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.TurnStarted -> {
                if (msg.turnId.isNotEmpty()) activityTurnId = msg.turnId
                setState(CognitionState.THINKING, "turn.started", msg.turnId)
                emitActivity()
            }
            is ServerMessage.TurnCompleted -> {
                if (activityTurnId == msg.turnId) activityTurnId = null
                setState(CognitionState.IDLE, "turn.completed", msg.turnId)
                emitActivity()
                onEvent?.invoke(SdkEvent.TurnDone(turnId = msg.turnId))
            }
            is ServerMessage.TurnAborted -> {
                if (activityTurnId == msg.turnId) activityTurnId = null
                setState(CognitionState.IDLE, "turn.aborted", msg.turnId)
                emitActivity()
            }
            else -> Unit // not owned by this connector
        }
    }

    /** Force-reset to IDLE (optimistic local clear). Fires onStateChange via setState so the
     *  orchestrator's deriver stays in sync; prevents the next turn.started short-circuiting. */
    fun reset() {
        activityTurnId = null
        setState(CognitionState.IDLE, "reset", null)
        emitActivity()
    }

    private fun emitActivity() {
        onActivityChange?.invoke(
            if (activityTurnId == null) CognitionState.IDLE else CognitionState.THINKING,
            activityTurnId,
        )
    }

    private fun setState(next: CognitionState, trigger: String, turnId: String?) {
        if (next == currentState) return
        log.info(
            "transition",
            mapOf("from" to currentState, "to" to next, "trigger" to trigger, "turnId" to turnId),
        )
        currentState = next
        onStateChange?.invoke(next)
    }

    companion object {
        const val CAPABILITY: String = "cognition.status"
    }
}
