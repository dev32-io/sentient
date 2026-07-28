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

    fun advance(revealed: Int, fullLen: Int, dtMs: Long, drain: Boolean): Int {
        if (revealed >= fullLen) return 0
        val gap = (fullLen - revealed).toDouble()
        val rate = if (drain) MAX else (BASE * (1 + gap * GAP_GAIN)).coerceIn(MIN, MAX)
        return (rate * dtMs / 1000.0).toInt().coerceAtMost(fullLen - revealed)
    }
}

data class RevealBubble(
    val turnId: String,
    val fullContent: String,
    val revealed: Int,
    val phase: LivePhase,
)

data class RevealState(
    val bubble: RevealBubble? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val lastTickMs: Long = 0,
) {
    fun visibleContent(): String = bubble?.let { it.fullContent.take(it.revealed) } ?: ""
}

/**
 * Pure reveal fold. No coroutines, no I/O. Accumulates deltas (no loss), advances the
 * cursor on ticks, drains after commit, drops everything on a session switch. The ticker
 * that emits [RevealTick] lives in ObserveChatUseCase.
 */
object RevealReducer {
    fun reduce(s: RevealState, e: Any): RevealState = when (e) {
        is SdkEvent.MessageStarted ->
            s.copy(bubble = RevealBubble(e.turnId, "", 0, LivePhase.STREAMING), tasks = emptyList())
        is SdkEvent.MessageDelta -> {
            val cur = s.bubble ?: RevealBubble(e.turnId, "", 0, LivePhase.STREAMING)
            s.copy(bubble = cur.copy(fullContent = cur.fullContent + e.chunk))
        }
        is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
        is SdkEvent.MessageCommitted -> s.copy(bubble = s.bubble?.copy(phase = LivePhase.DRAINING))
        is SdkEvent.SessionSwitched -> RevealState()
        is RevealTick -> {
            val cur = s.bubble ?: return s
            val dt = if (s.lastTickMs == 0L) 0L else e.nowMs - s.lastTickMs
            val delta = RevealRate.advance(cur.revealed, cur.fullContent.length, dt, cur.phase == LivePhase.DRAINING)
            val revealed = cur.revealed + delta
            val done = cur.phase == LivePhase.DRAINING && revealed >= cur.fullContent.length
            s.copy(
                bubble = if (done) null else cur.copy(revealed = revealed),
                tasks = if (done) emptyList() else s.tasks,
                lastTickMs = e.nowMs,
            )
        }
        else -> s
    }

    private fun upsert(list: List<TaskSnapshotItem>, t: TaskSnapshotItem): List<TaskSnapshotItem> =
        (list.filterNot { it.toolCallId == t.toolCallId } + t).sortedBy { it.startedAtMs }
}
