package io.sentient.mobiledata.repository

import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Typewriter tick interval — ~60fps feel without burning battery. */
private const val REVEAL_TICK_MS = 16L

/**
 * In-flight streaming bubble managed by the reveal reducer.
 *
 * @param cycleId     Cycle that produced this bubble (UI join key for tools).
 * @param fullContent Full accumulated text — grows on every [SdkEvent.MessageDelta].
 * @param revealed    Characters made visible so far by the ticker. Lags behind [fullContent].
 * @param phase       [LivePhase.STREAMING] while deltas arrive; [LivePhase.DRAINING] after commit.
 */
data class LiveBubble(
    val cycleId: String,
    val fullContent: String,
    val revealed: Int,
    val phase: LivePhase,
)

/**
 * Live accumulator state: the in-flight reveal bubble + its tasks + the last tick timestamp.
 *
 * The bubble persists through [LivePhase.DRAINING] until `revealed >= fullContent.length`;
 * tasks survive into drain so tool pills remain visible until the reveal completes.
 */
data class LiveState(
    val live: LiveBubble? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val lastTickMs: Long = 0,
) {
    /** The substring of [LiveBubble.fullContent] visible to the UI right now. */
    fun visibleContent(): String = live?.let { it.fullContent.take(it.revealed) } ?: ""
}

/**
 * ReplyStreamRepository — owns the live in-flight assistant reply.
 *
 * Folds the SDK's no-loss [events] SharedFlow through the pure [reduce] function
 * into [live], and runs the clock-driven reveal ticker that advances the
 * typewriter cursor every [REVEAL_TICK_MS] ms (at MAX rate once draining).
 *
 * No-loss guarantee: every SdkEvent is consumed from the no-loss SharedFlow and
 * accumulated in [reduce]; the [live] StateFlow may conflate intermediate
 * emissions — that is intentional, because content grows monotonically. The
 * reveal cursor is advanced by the ticker, not by conflation, so no content is lost.
 *
 * Per-conversation lifecycle: this state belongs to ONE conversation. On
 * [SdkEvent.SessionSwitched] the reducer resets [live] to empty (a prior
 * conversation's reveal bubble + tasks must never leak into the next), and the
 * collector fires [onSessionSwitched] so the session coordinator can clear
 * sibling per-conversation state (the outbox) in lockstep.
 *
 * @param events   SDK's no-loss SharedFlow of [SdkEvent] (replay=0, SUSPEND overflow).
 * @param scope    Coroutine scope for the collector + ticker; the session's lifecycle scope.
 * @param clock    Wall-clock source for the reveal ticker; injected for testability.
 * @param onSessionSwitched Fired when a [SdkEvent.SessionSwitched] is observed, after the
 *   live reset, so the coordinator can clear sibling conversation-scoped state.
 */
class ReplyStreamRepository(
    events: SharedFlow<SdkEvent>,
    scope: CoroutineScope,
    private val clock: Clock = Clock { 0L },
    private val onSessionSwitched: () -> Unit = {},
) {
    private val log = createLogger("data", "reply-stream")
    private val _live = MutableStateFlow(LiveState())
    val live: StateFlow<LiveState> = _live.asStateFlow()

    init {
        // Fold SdkEvents into LiveState; notify on a conversation switch.
        scope.launch {
            events.collect { event ->
                _live.value = reduce(_live.value, event)
                if (event is SdkEvent.SessionSwitched) {
                    log.info("session-switched — live reset + notify")
                    onSessionSwitched()
                }
            }
        }
        // Advance the reveal cursor every REVEAL_TICK_MS when a live bubble exists.
        scope.launch {
            while (true) {
                if (_live.value.live != null) {
                    _live.value = reduce(_live.value, RevealEvent.Tick(clock.nowMs()))
                }
                delay(REVEAL_TICK_MS)
            }
        }
    }

    companion object {
        /**
         * Pure reducer — no side effects, no I/O. Accepts both [SdkEvent] and
         * [RevealEvent] (typed as [Any]) to keep the reveal logic co-located and testable.
         *
         * No-loss guarantee: SdkEvent accumulation is monotonically growing — fullContent
         * only appends, revealed only advances. RevealEvent ticks advance the cursor without
         * touching the accumulated text. Commit transitions to DRAINING and the ticker
         * finishes the drain. A session switch drops the whole bubble + tasks.
         */
        fun reduce(s: LiveState, e: Any): LiveState = when (e) {
            is SdkEvent.MessageStarted ->
                s.copy(
                    live = LiveBubble(
                        cycleId = e.cycleId,
                        fullContent = "",
                        revealed = 0,
                        phase = LivePhase.STREAMING,
                    ),
                    tasks = emptyList(),
                )
            is SdkEvent.MessageDelta -> {
                val cur = s.live ?: LiveBubble(
                    cycleId = e.cycleId,
                    fullContent = "",
                    revealed = 0,
                    phase = LivePhase.STREAMING,
                )
                s.copy(live = cur.copy(fullContent = cur.fullContent + e.chunk))
            }
            is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
            is SdkEvent.MessageCommitted ->
                // Transition to DRAINING; ticker will null the bubble once reveal catches up.
                // Tasks remain so tool pills stay visible during drain.
                s.copy(live = s.live?.copy(phase = LivePhase.DRAINING))
            is SdkEvent.SessionSwitched ->
                // The conversation changed: drop the prior reply's reveal bubble + tasks
                // so they never leak into the next conversation's timeline.
                LiveState()
            is RevealEvent.Tick -> {
                val cur = s.live ?: return s
                val dt = if (s.lastTickMs == 0L) 0L else e.nowMs - s.lastTickMs
                val delta = RevealRate.advance(
                    revealed = cur.revealed,
                    fullLen = cur.fullContent.length,
                    dtMs = dt,
                    drain = cur.phase == LivePhase.DRAINING,
                )
                val newRevealed = cur.revealed + delta
                val done = cur.phase == LivePhase.DRAINING && newRevealed >= cur.fullContent.length
                s.copy(
                    live = if (done) null else cur.copy(revealed = newRevealed),
                    tasks = if (done) emptyList() else s.tasks,
                    lastTickMs = e.nowMs,
                )
            }
            else -> s
        }

        private fun upsert(
            list: List<TaskSnapshotItem>,
            t: TaskSnapshotItem,
        ): List<TaskSnapshotItem> =
            (list.filterNot { it.taskId == t.taskId } + t).sortedBy { it.startedAtMs }
    }
}
