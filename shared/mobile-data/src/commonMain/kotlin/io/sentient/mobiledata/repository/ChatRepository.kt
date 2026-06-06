package io.sentient.mobiledata.repository

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
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
 * the committed [timeline] with that live state.
 *
 * No-loss guarantee: every SdkEvent is consumed from the no-loss SharedFlow and
 * accumulated in [reduce]; the [liveState] StateFlow may conflate intermediate
 * emissions — that is intentional, because content grows monotonically. The UI
 * always renders the latest accumulated content.
 *
 * @param events   SDK's no-loss SharedFlow of [SdkEvent] (replay=0, SUSPEND overflow).
 * @param timeline SDK's committed history StateFlow.
 * @param scope    Coroutine scope for the collector; should be the component's lifecycle scope.
 */
class ChatRepository(
    private val events: SharedFlow<SdkEvent>,
    private val timeline: StateFlow<List<ChatMessage>>,
    scope: CoroutineScope,
) {
    private val liveState = MutableStateFlow(LiveState())

    init {
        scope.launch {
            events.collect { event ->
                liveState.value = reduce(liveState.value, event)
            }
        }
    }

    /**
     * Combines the committed [timeline] with the accumulated [liveState] into a
     * [Flow] of [SentientResult.Success<ChatModel>].
     *
     * Pending field is included (empty until Task 2.6b — Outbox integration).
     */
    val chatStream: Flow<SentientResult<ChatModel>> =
        combine(timeline, liveState) { committed, ls ->
            SentientResult.Success(
                ChatModel(
                    committed = committed,
                    pending = emptyList(),
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
