package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.scan

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
    private val log = createLogger("data", "observe-chat")
    operator fun invoke(pending: Flow<List<PendingMessage>>): Flow<ChatModel> =
        combine(
            conversation.timeline,
            revealFlow(),
            pending,
            historyLoadingFlow(),
            conversation.echoedPendingIds,
        ) { committed, rs, pendingMsgs, loading, echoedPendingIds ->
            // Reconcile against the LIVE echo, NOT committed.pendingId: the DB-backed
            // timeline strips pendingId, so committed.mapNotNull { it.pendingId } would be
            // empty and the optimistic bubble would never drop. echoedPendingIds comes from
            // the SDK's own (pre-strip) timeline (see ConversationRepository.echoedPendingIds).
            val visiblePending = pendingMsgs.filter { it.id !in echoedPendingIds }
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
            ChatModel(
                committed = visibleCommitted,
                pending = visiblePending,
                live = liveBubble,
                tasks = rs.tasks,
                historyLoading = loading,
                reconciledPendingIds = echoedPendingIds,
            )
        }

    /**
     * History-loading gate, derived without touching the reveal ticker's coroutine.
     * An EXISTING-session switch emits SessionSwitched(nonEmpty) → spinner ON; the
     * gateway then sends conversation.snapshot which REPLACES the timeline → the next
     * timeline emission turns it OFF. A brand-new chat emits SessionSwitched("") (empty
     * id, empty immediate snapshot) → never turns the spinner on.
     *
     * Merged so both signals fold serially into one scan accumulator (no shared mutable
     * cell). distinctUntilChanged drops idle no-op timeline re-emits downstream.
     */
    private fun historyLoadingFlow(): Flow<Boolean> {
        val switches = conversation.liveEvents
            .map { it as? SdkEvent.SessionSwitched }
            .map { if (it != null && it.sessionId.isNotEmpty()) LoadingSignal.SwitchStarted else null }
        val snapshots = conversation.timeline.map { LoadingSignal.SnapshotArrived }
        return merge(switches, snapshots)
            .scan(false) { loading, signal ->
                when (signal) {
                    LoadingSignal.SwitchStarted -> true
                    LoadingSignal.SnapshotArrived -> false
                    null -> loading
                }
            }
            .distinctUntilChanged()
            .onEach { log.info("history-loading", mapOf("loading" to it)) }
    }

    /** Reveal stream: a single-coroutine fold of liveEvents + a 16ms ticker. The scan's
     *  accumulator is the only state, updated serially by merge → no shared mutable cell,
     *  correct on any dispatcher. distinctUntilChanged drops idle no-op ticks downstream. */
    private fun revealFlow(): Flow<RevealState> {
        val ticks = flow {
            while (true) {
                delay(REVEAL_TICK_MS)
                emit(RevealTick(clock.nowMs()))
            }
        }
        return merge(conversation.liveEvents, ticks)
            .onEach { if (it is SdkEvent.SessionSwitched) log.info("conversation switch — reveal reset") }
            .scan(RevealState()) { state, event -> RevealReducer.reduce(state, event) }
            .distinctUntilChanged()
    }
}

/** The two signals that drive the history-loading gate. */
private enum class LoadingSignal { SwitchStarted, SnapshotArrived }
