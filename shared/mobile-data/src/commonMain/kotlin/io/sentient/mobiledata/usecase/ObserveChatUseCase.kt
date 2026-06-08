package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Reveal ticker cadence — ~60fps feel without burning battery. */
private const val REVEAL_TICK_MS = 16L

/**
 * Projects the single chat list a screen renders for the ACTIVE conversation:
 * folds [ConversationRepository.liveEvents] → reveal (typewriter ticker runs inside this
 * flow), then combines committed [ConversationRepository.timeline] + the revealed bubble +
 * the VM's [pending] outbound cache. Applies one-bubble-per-cycle (suppress the committed
 * twin while its live bubble is on screen) and reconcile-by-pendingId.
 *
 * Per-conversation: the reveal fold + ticker live inside the returned flow, so they are
 * cancelled when collection stops (conversation switch / VM teardown). No reset() needed.
 */
class ObserveChatUseCase(
    private val conversation: ConversationRepository,
    private val clock: Clock,
) {
    operator fun invoke(pending: Flow<List<PendingMessage>>): Flow<ChatModel> =
        combine(conversation.timeline, revealFlow(), pending) { committed, rs, pendingMsgs ->
            val committedPendingIds = committed.mapNotNull { it.pendingId }.toSet()
            val visiblePending = pendingMsgs.filter { it.id !in committedPendingIds }
            val liveCycleId = rs.bubble?.cycleId
            val visibleCommitted =
                if (liveCycleId == null) committed
                else committed.filter { it.cycleId != liveCycleId }
            val liveBubble = rs.bubble?.let {
                ChatMessage(
                    ts = 0,
                    role = "assistant",
                    content = rs.visibleContent(),
                    streaming = true,
                    cycleId = it.cycleId,
                )
            }
            ChatModel(committed = visibleCommitted, pending = visiblePending, live = liveBubble, tasks = rs.tasks)
        }

    /** Reveal stream: folds events into RevealState and self-ticks while a bubble exists. */
    private fun revealFlow(): Flow<RevealState> = channelFlow {
        val state = MutableStateFlow(RevealState())
        launch { conversation.liveEvents.collect { state.value = RevealReducer.reduce(state.value, it) } }
        launch {
            while (isActive) {
                if (state.value.bubble != null) state.value = RevealReducer.reduce(state.value, RevealTick(clock.nowMs()))
                delay(REVEAL_TICK_MS)
            }
        }
        state.collect { send(it) }
    }
}
