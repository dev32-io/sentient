package io.sentient.mobiledata.usecase

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.SdkEvent

/** Phase of the live in-flight bubble. */
enum class LivePhase { STREAMING, DRAINING }

/** Ticker input for the reveal cursor (kept distinct from SdkEvent). */
data class RevealTick(val nowMs: Long)

/** Typewriter pacing — ports webui src/config/typewriter.ts. Pure. */
internal object RevealRate {
    const val BASE = 30.0
    const val MIN = 15.0
    const val MAX = 150.0
    const val GAP_GAIN = 0.02

    /**
     * Characters earned in [dtMs] at the current gap, as a REAL number.
     *
     * Real, not truncated, because the caller carries the fraction forward. One
     * tick of 16 ms at the streaming rate is worth well under a whole character
     * — `30 * (1 + gap * 0.02)` only reaches the 62.5 chars/s that a 16 ms tick
     * needs to earn its first whole character once the gap is past ~55 — so
     * rounding down PER TICK yielded a permanent zero the moment the reveal
     * caught up. The bubble then froze mid-sentence in STREAMING phase forever,
     * and since `done` is only reachable from DRAINING it never cleared, which
     * kept ObserveChatUseCase hiding every committed row of that turn. The
     * animation stalling has to stay an animation bug; it must never be able to
     * swallow durable history.
     */
    fun earned(revealed: Int, fullLen: Int, dtMs: Long, drain: Boolean): Double {
        if (revealed >= fullLen) return 0.0
        val gap = (fullLen - revealed).toDouble()
        val rate = if (drain) MAX else (BASE * (1 + gap * GAP_GAIN)).coerceIn(MIN, MAX)
        return rate * dtMs / 1000.0
    }
}

data class RevealBubble(
    val turnId: String,
    val fullContent: String,
    val revealed: Int,
    val phase: LivePhase,
    /**
     * WHICH BUBBLE this is, when the gateway names one. A ReAct turn produces
     * text more than once and it is ONE bubble that grew — except across a
     * message the person sent mid-turn, which is drawn between the stretches
     * and starts a new one. The gateway decides where that falls; this is the
     * key it stamps. Null against a gateway that does not send it, which
     * degrades to the old one-bubble-per-turn behaviour.
     */
    val messageId: String? = null,
) {
    /** What this bubble is identified by — its message when it has one, its
     *  turn otherwise. `ObserveChatUseCase` hides the committed rows carrying
     *  the same key, so the swap at turn end shows exactly what was streamed. */
    val key: String get() = messageId ?: turnId
}

data class RevealState(
    val bubble: RevealBubble? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val lastTickMs: Long = 0,
    /** Sub-character progress carried between ticks, in [0, 1). Without it a
     *  tick worth less than one whole character earns nothing and the reveal
     *  stalls — see [RevealRate.earned]. Reset whenever the bubble is. */
    val revealCarry: Double = 0.0,
) {
    fun visibleContent(): String = bubble?.let { it.fullContent.take(it.revealed) } ?: ""
}

/**
 * Pure reveal fold. No coroutines, no I/O. Accumulates deltas (no loss), advances the
 * cursor on ticks, drains after commit, drops everything on a session switch. The ticker
 * that emits [RevealTick] lives in ObserveChatUseCase.
 *
 * EVERY BUBBLE MUST BE ABLE TO REACH null. ObserveChatUseCase hides every committed
 * row whose turnId matches the live bubble's, so a bubble with no exit does not just
 * stall an animation — it hides that turn's durable history for as long as the screen
 * lives. Two exits were missing and both were silent: an aborted turn (no
 * MessageCommitted is ever emitted for one — see InFlightMessageConnector.onAborted)
 * and a reveal whose per-tick progress truncated to zero (see [RevealRate.earned]).
 */
object RevealReducer {
    fun reduce(s: RevealState, e: Any): RevealState = when (e) {
        // A new key REPLACES the live bubble rather than extending it. Two ways
        // in: a new turn, and — mid-turn — the gateway rotating the message id
        // because the person spoke. In the second case the stretch just dropped
        // is already committed, so its durable row unhides the instant this
        // bubble stops matching it; carrying it on would hide that row behind an
        // animation for a reply that has already finished.
        is SdkEvent.MessageStarted ->
            if (s.bubble != null && s.bubble.key == (e.messageId ?: e.turnId)) {
                s
            } else {
                s.copy(
                    bubble = RevealBubble(e.turnId, "", 0, LivePhase.STREAMING, e.messageId),
                    tasks = if (s.bubble?.turnId == e.turnId) s.tasks else emptyList(),
                    revealCarry = 0.0,
                )
            }
        is SdkEvent.MessageDelta -> {
            val key = e.messageId ?: e.turnId
            // A delta for a bubble other than the live one opens it (a resume
            // replay can deliver a delta before its MessageStarted).
            val cur =
                s.bubble?.takeIf { it.key == key } ?: RevealBubble(e.turnId, "", 0, LivePhase.STREAMING, e.messageId)
            s.copy(bubble = cur.copy(fullContent = cur.fullContent + e.chunk))
        }
        is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
        // Turn-matched: a turn owning several bubbles commits each of them, and
        // only the one still on screen should start draining.
        is SdkEvent.MessageCommitted ->
            if (s.bubble != null && s.bubble.key == (e.message.messageId ?: e.message.turnId ?: s.bubble.key)) {
                s.copy(bubble = s.bubble.copy(phase = LivePhase.DRAINING))
            } else {
                s
            }
        // Same `turn.completed` frame as MessageCommitted, but raised by a different
        // connector (CognitionStatusConnector), so it survives the one way that one
        // can go missing: InFlightMessageConnector.onCompleted early-returns when it
        // holds no buffer for the turn, emitting nothing. Idempotent — DRAINING is
        // already DRAINING — and turn-matched so it cannot drain a peer turn's bubble.
        is SdkEvent.TurnDone ->
            if (s.bubble?.turnId == e.turnId) s.copy(bubble = s.bubble.copy(phase = LivePhase.DRAINING)) else s
        // A cut turn has no drain to play out: the gateway committed a cutoff entry
        // (runtime/cancellation.ts) and THAT is what the user must see — carrying the
        // bubble on would keep the interrupted row, its marker, and its tool tiles
        // hidden behind an animation for a reply that already stopped. Tasks go with
        // it; the turn's tiles are committed entries now.
        is SdkEvent.TurnAborted -> if (s.bubble?.turnId == e.turnId) s.copy(bubble = null, tasks = emptyList()) else s
        is SdkEvent.SessionSwitched -> RevealState()
        is RevealTick -> {
            val cur = s.bubble ?: return s
            val dt = if (s.lastTickMs == 0L) 0L else e.nowMs - s.lastTickMs
            val drain = cur.phase == LivePhase.DRAINING
            val earned = s.revealCarry + RevealRate.earned(cur.revealed, cur.fullContent.length, dt, drain)
            val whole = earned.toInt().coerceAtMost(cur.fullContent.length - cur.revealed)
            val revealed = cur.revealed + whole
            val done = drain && revealed >= cur.fullContent.length
            s.copy(
                bubble = if (done) null else cur.copy(revealed = revealed),
                tasks = if (done) emptyList() else s.tasks,
                lastTickMs = e.nowMs,
                revealCarry = if (done) 0.0 else earned - whole,
            )
        }
        else -> s
    }

    private fun upsert(list: List<TaskSnapshotItem>, t: TaskSnapshotItem): List<TaskSnapshotItem> =
        (list.filterNot { it.toolCallId == t.toolCallId } + t).sortedBy { it.startedAtMs }
}
