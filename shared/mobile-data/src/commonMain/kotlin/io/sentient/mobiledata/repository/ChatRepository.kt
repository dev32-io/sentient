package io.sentient.mobiledata.repository

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine

/**
 * ChatRepository — projects the single chat list a screen renders, by combining
 * three sources into one [ChatModel] stream:
 *   - the SDK's committed [timeline],
 *   - the live reveal bubble from [ReplyStreamRepository] ([live]),
 *   - the optimistic [pending] outbox from [OutboxRepository].
 *
 * Pure projection: it owns NO mutable state and subscribes to nothing. Sends +
 * retries live on [OutboxRepository]; reveal folding + the conversation-switch
 * reset live on [ReplyStreamRepository]. That split keeps each piece's lifecycle
 * and call-signs clear and independently testable.
 *
 * Reconciliation: a pending message is visible until a committed user message with
 * the same pendingId appears in the timeline — exact id match, no text comparison.
 *
 * One bubble per cycle (webui parity): while the live reveal bubble is on screen,
 * its committed twin (same cycleId) is suppressed, so the bubble keeps a stable
 * list index across the reveal→commit handoff and the UI morphs a single node
 * (text grows then settles, tool pills stay attached) rather than stacking two.
 */
class ChatRepository(
    private val timeline: StateFlow<List<ChatMessage>>,
    private val live: StateFlow<LiveState>,
    private val pending: StateFlow<List<PendingMessage>>,
) {
    val chatStream: Flow<SentientResult<ChatModel>> =
        combine(timeline, live, pending) { committed, ls, pendingMsgs ->
            val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
            val visiblePending = pendingMsgs.filter { it.id !in committedPendingIds }
            val liveCycleId = ls.live?.cycleId
            val visibleCommitted =
                if (liveCycleId == null) committed
                else committed.filter { it.cycleId != liveCycleId }
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
                    committed = visibleCommitted,
                    pending = visiblePending,
                    live = liveBubble,
                    tasks = ls.tasks,
                ),
            )
        }
}
