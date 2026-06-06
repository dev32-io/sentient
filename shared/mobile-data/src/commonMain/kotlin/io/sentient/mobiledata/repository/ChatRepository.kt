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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Live accumulator state: the in-flight streaming bubble + its tasks.
 * Cleared on [SdkEvent.MessageCommitted]; the committed text arrives
 * authoritatively via [ChatRepository.timeline].
 */
data class LiveState(
    val live: ChatMessage? = null,
    val tasks: List<TaskSnapshotItem> = emptyList(),
)

/**
 * ChatRepository — folds the SDK's no-loss [events] SharedFlow into a live
 * [LiveState] via the pure [reduce] function, and exposes [chatStream] combining
 * the committed [timeline] with that live state and the optimistic [outbox].
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
 * emissions — that is intentional, because content grows monotonically. The UI
 * always renders the latest accumulated content.
 *
 * @param events   SDK's no-loss SharedFlow of [SdkEvent] (replay=0, SUSPEND overflow).
 * @param timeline SDK's committed history StateFlow.
 * @param scope    Coroutine scope for the collector; should be the component's lifecycle scope.
 * @param send     Invoked by the outbox when flushing a QUEUED message; wired to sdk.sendText(text, pendingId) by the session factory.
 * @param newId    Generates a unique pending message id; injected for testability.
 */
class ChatRepository(
    private val events: SharedFlow<SdkEvent>,
    private val timeline: StateFlow<List<ChatMessage>>,
    scope: CoroutineScope,
    private val send: (text: String, pendingId: String) -> Unit,
    private val newId: () -> String,
) {
    private val log = createLogger("data", "chat")
    private val liveState = MutableStateFlow(LiveState())
    private val outbox = Outbox(send = { send(it.text, it.id) })
    private val outboxState = MutableStateFlow<List<PendingMessage>>(emptyList())
    private var connected = false

    init {
        scope.launch {
            events.collect { event ->
                liveState.value = reduce(liveState.value, event)
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
     */
    val chatStream: Flow<SentientResult<ChatModel>> =
        combine(timeline, liveState, outboxState) { committed, ls, pending ->
            val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
            val visiblePending = pending.filter { it.id !in committedPendingIds }
            SentientResult.Success(
                ChatModel(
                    committed = committed,
                    pending = visiblePending,
                    live = ls.live,
                    tasks = ls.tasks,
                ),
            )
        }

    companion object {
        /**
         * Pure reducer — no side effects, no I/O. Consumes every [SdkEvent] in
         * the order it was emitted, ensuring accumulated content is monotonically
         * growing (no-loss guarantee at the reduce level).
         */
        fun reduce(s: LiveState, e: SdkEvent): LiveState = when (e) {
            is SdkEvent.MessageStarted ->
                s.copy(
                    live = ChatMessage(
                        ts = 0,
                        role = "assistant",
                        content = "",
                        streaming = true,
                        cycleId = e.cycleId,
                    ),
                    tasks = emptyList(),
                )
            is SdkEvent.MessageDelta -> {
                val cur = s.live ?: ChatMessage(
                    ts = 0,
                    role = "assistant",
                    content = "",
                    streaming = true,
                    cycleId = e.cycleId,
                )
                s.copy(live = cur.copy(content = cur.content + e.chunk))
            }
            is SdkEvent.TaskUpserted -> s.copy(tasks = upsert(s.tasks, e.task))
            is SdkEvent.MessageCommitted -> s.copy(live = null, tasks = emptyList())
            else -> s
        }

        private fun upsert(
            list: List<TaskSnapshotItem>,
            t: TaskSnapshotItem,
        ): List<TaskSnapshotItem> =
            (list.filterNot { it.taskId == t.taskId } + t).sortedBy { it.startedAtMs }
    }
}
