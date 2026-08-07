package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository
import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
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
 * the VM's [pending] outbound cache. Applies one-bubble-per-turn (suppress the committed
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

    /**
     * Cold-reconcile: a COLD REST history snapshot (an existing-conversation switch
     * reload, or a `recovered:false` in-place refetch) carries NO pendingId, so the
     * normal reconcile-by-pendingId can't drop the optimistic copy — the authoritative
     * "hello" lands committed with pendingId=null while the optimistic "hello" stays in
     * the cache, painting a DUPLICATE bubble. On a cold replace every still-present
     * optimistic entry is either now in the authoritative history or was already swept
     * to FAILED by the unacked-timeout, so we drop them all. Pure + idempotent: a no-op
     * when the cache is already empty.
     */
    fun onColdHistoryReplace(cache: OutboundCache) {
        val before = cache.pending.value.size
        cache.dropPending()
        if (before > 0) log.info("cold-history-replace.drop-pending", mapOf("dropped" to before))
    }

    /**
     * Cold-replace signal: an EXISTING-conversation switch (`SessionSwitched` with a
     * non-empty id) reloads authoritative history via REST. A brand-new chat emits
     * `SessionSwitched("")` (empty id) and is NOT a cold replace — its optimistic send
     * reconciles by the live echo. The VM taps this to drive [onColdHistoryReplace].
     */
    fun coldHistoryReplaceSignal(): Flow<Unit> =
        conversation.liveEvents
            .filterIsInstance<SdkEvent.SessionSwitched>()
            .filter { it.sessionId.isNotEmpty() }
            .onEach { log.info("cold-history-replace.signal", mapOf("sessionId" to it.sessionId)) }
            .map { }

    operator fun invoke(pending: Flow<List<PendingMessage>>): Flow<ChatModel> =
        combine(
            conversation.timeline,
            revealFlow(),
            // Paired to stay within combine's 5-flow arity — no relationship between
            // the two beyond both being plain per-emission lists.
            combine(pending, conversation.tasks) { pendingMsgs, tasks -> pendingMsgs to tasks },
            historyLoadingFlow(),
            conversation.echoedPendingIds,
        ) { committed, rs, (pendingMsgs, tasks), loading, echoedPendingIds ->
            // Reconcile against the LIVE echo's echoedPendingIds, not committed.pendingId:
            // cold REST snapshots carry pendingId=null (there is no DB), so
            // committed.mapNotNull { it.pendingId } would be empty and the optimistic
            // bubble would never drop. echoedPendingIds is sourced from the SDK's in-memory
            // timeline before any null-strip (see ConversationRepository.echoedPendingIds).
            val visiblePending = pendingMsgs.filter { it.id !in echoedPendingIds }
            // Hide ONLY the committed row this live bubble is painting, matched on the
            // reply and nothing else.
            //
            // The turn fallback this replaces was the bug: a row with no replyId — a
            // user row, a tool tile, an entry written before the column existed —
            // matched on turnId alone and vanished behind the bubble for the length of
            // the reveal. The gateway now folds a reply into ONE committed item
            // carrying its own replyId, so there is exactly one row to hide and no
            // reason to guess.
            val bubble = rs.bubble
            val visibleCommitted =
                if (bubble?.replyId == null) {
                    committed
                } else {
                    committed.filter { it.replyId != bubble.replyId }
                }
            val liveBubble = rs.bubble?.let {
                ChatMessage(
                    ts = 0,
                    role = "assistant",
                    content = rs.visibleContent(),
                    streaming = true,
                    turnId = it.turnId,
                    replyId = it.replyId,
                )
            }
            ChatModel(
                committed = visibleCommitted,
                pending = visiblePending,
                live = liveBubble,
                tasks = tasks,
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
