package io.sentient.mobiledata.repository

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.Outbox
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
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
 * ChatRepository — folds the SDK's no-loss [events] SharedFlow into a live
 * [LiveState] via the pure [reduce] function, and exposes [chatStream] combining
 * the committed [timeline] with that live state and the optimistic [outbox].
 *
 * Reveal/drain:
 * A clock-driven ticker fires every [REVEAL_TICK_MS] ms. On each tick it
 * advances `revealed` via [RevealRate.advance] toward `fullContent.length`.
 * When [SdkEvent.MessageCommitted] arrives the bubble enters [LivePhase.DRAINING]
 * and the ticker continues at MAX rate until drain is complete, then nulls the bubble.
 * Tool tasks remain in [LiveState.tasks] throughout drain so live pills stay visible.
 *
 * Outbox lifecycle:
 * - [send] enqueues an optimistic QUEUED bubble with a client-generated [newId]; the
 *   bubble is visible immediately in [chatStream].
 * - [setConnected] tracks connection readiness. When true, flushes all QUEUED outbox
 *   messages immediately. [send] while connected also flushes immediately so messages
 *   sent on an already-READY connection are never stuck as QUEUED.
 * - When the gateway echoes the committed user entry (carrying the same pendingId), the
 *   3-way combine reconciles it away by exact id match — no text comparison needed.
 * - [failOutbox] marks all QUEUED messages FAILED; they remain visible for retry/dismiss.
 *
 * No-loss guarantee: every SdkEvent is consumed from the no-loss SharedFlow and
 * accumulated in [reduce]; the [liveState] StateFlow may conflate intermediate
 * emissions — that is intentional, because content grows monotonically. The reveal
 * cursor is advanced by the ticker, not by conflation, so no content is lost.
 *
 * @param events   SDK's no-loss SharedFlow of [SdkEvent] (replay=0, SUSPEND overflow).
 * @param timeline SDK's committed history StateFlow.
 * @param scope    Coroutine scope for the collector; should be the component's lifecycle scope.
 * @param send     Invoked by the outbox when flushing a QUEUED message; wired to sdk.sendText(text, pendingId) by the session factory.
 * @param newId    Generates a unique pending message id; injected for testability.
 * @param clock    Wall-clock source for the reveal ticker; injected for testability.
 */
class ChatRepository(
    private val events: SharedFlow<SdkEvent>,
    private val timeline: StateFlow<List<ChatMessage>>,
    scope: CoroutineScope,
    private val send: (text: String, pendingId: String) -> Unit,
    private val newId: () -> String,
    private val clock: Clock = Clock { 0L },
) {
    private val log = createLogger("data", "chat")
    private val liveState = MutableStateFlow(LiveState())
    private val outbox = Outbox(send = { send(it.text, it.id) })
    private val outboxState = MutableStateFlow<List<PendingMessage>>(emptyList())
    private var connected = false

    init {
        // Fold SdkEvents into LiveState.
        scope.launch {
            events.collect { event ->
                liveState.value = reduce(liveState.value, event)
            }
        }
        // Advance the reveal cursor every REVEAL_TICK_MS when a live bubble exists.
        scope.launch {
            while (true) {
                if (liveState.value.live != null) {
                    liveState.value = reduce(liveState.value, RevealEvent.Tick(clock.nowMs()))
                }
                delay(REVEAL_TICK_MS)
            }
        }
    }

    private fun flush() {
        val queued = outbox.snapshot().count { it.status == MessageStatus.QUEUED }
        outbox.onReady()
        outboxState.value = outbox.snapshot()
        log.info("outbox.flush", mapOf("pending" to queued))
    }

    /**
     * Enqueues an optimistic QUEUED message and returns its pending id.
     * The bubble is visible immediately in [chatStream]. If the connection is
     * already READY ([connected] == true), the message is flushed immediately
     * (SENT + [send] callback invoked). Otherwise it waits for [setConnected].
     */
    fun send(text: String): String {
        val id = newId()
        log.info("send.optimistic", mapOf("pendingId" to id, "len" to text.length))
        outbox.enqueue(PendingMessage(id, text))
        outboxState.value = outbox.snapshot()
        if (connected) flush()
        return id
    }

    /**
     * Called by the session factory on every connection status change.
     * When [isConnected] becomes true, flushes all QUEUED outbox messages —
     * marks them SENT and invokes the underlying [send] callback for each.
     */
    fun setConnected(isConnected: Boolean) {
        connected = isConnected
        if (isConnected) flush()
    }

    /**
     * Re-queues a FAILED message so the next flush re-sends it. No-op if the message is not
     * in FAILED state (QUEUED and SENT messages are left untouched). Flushes immediately when
     * the connection is already READY.
     */
    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        outbox.retry(pendingId)
        outboxState.value = outbox.snapshot()
        if (connected) flush()
    }

    /**
     * Marks all QUEUED outbox messages as FAILED. They remain visible in [chatStream]
     * for the user to retry or dismiss.
     */
    fun failOutbox(reason: String) {
        val pending = outbox.snapshot().size
        outbox.failAll(reason)
        outboxState.value = outbox.snapshot()
        log.warn("outbox.fail", mapOf("reason" to reason, "pending" to pending))
    }

    /**
     * 3-way combine of committed [timeline], [liveState], and [outboxState].
     *
     * Reconciliation rule: a pending message is visible until a committed user message
     * with the same pendingId appears in the timeline. Exact id match — no text comparison.
     * FAILED messages are not in committed, so they remain visible until retry/dismiss.
     *
     * The live bubble rendered here shows the revealed substring only; the UI reads
     * [visibleContent] to get the typewriter slice rather than the full accumulated text.
     */
    val chatStream: Flow<SentientResult<ChatModel>> =
        combine(timeline, liveState, outboxState) { committed, ls, pending ->
            val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
            val visiblePending = pending.filter { it.id !in committedPendingIds }
            val liveBubble = ls.live?.let {
                ChatMessage(
                    ts = 0,
                    role = "assistant",
                    content = ls.visibleContent(),
                    streaming = true,
                    cycleId = it.cycleId,
                )
            }
            SentientResult.Success(
                ChatModel(
                    committed = committed,
                    pending = visiblePending,
                    live = liveBubble,
                    tasks = ls.tasks,
                ),
            )
        }

    companion object {
        /**
         * Pure reducer — no side effects, no I/O. Accepts both [SdkEvent] and
         * [RevealEvent] (typed as [Any]) to keep the reveal logic co-located and testable.
         *
         * No-loss guarantee: SdkEvent accumulation is monotonically growing — fullContent
         * only appends, revealed only advances. RevealEvent ticks advance the cursor without
         * touching the accumulated text. Commit transitions to DRAINING and the ticker
         * finishes the drain.
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
