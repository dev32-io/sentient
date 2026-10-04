// Route-fenced REST mirror with a live tail retained during each history fetch.
// Owned by the serialized SDK dispatcher, including REST completion callbacks.
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.protocol.ServerMessage

class ConversationHistoryConnector(
    private val onSnapshot: ((List<ConversationFeedItem>) -> Unit)? = null,
    private val onEntry: ((ConversationFeedItem) -> Unit)? = null,
    private val onUpdate: ((List<ConversationFeedItem>) -> Unit)? = null,
    private val onEvent: ((SdkEvent) -> Unit)? = null,
    // Fired AFTER the generation is incremented, with the post-bump generation
    // token. The caller uses both to launch the REST fetch with the correct
    // generation so replaceMirror(forGeneration) will match and apply, and
    // to reset cross-conversation derivation state before the new history loads.
    private val onHistoryNeeded: ((sessionId: String, generation: Int) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "conversation-history")

    private var mirror: List<ConversationFeedItem> = emptyList()

    // Generation gate: increments on session.switched, checked on replaceMirror.
    // A fast second switch invalidates a slow first REST fetch so the newer switch
    // wins and the older response is silently discarded.
    private var generation: Int = 0

    // True between session.switched and the REST history arriving via replaceMirror.
    private var awaitingHistory: Boolean = false
    private var awaitingMintHistory: Boolean = false
    private var targetSessionId: String? = null
    private var liveTail: List<ConversationFeedItem> = emptyList()

    /** Current ordered mirror of the feed. Safe to read synchronously. */
    fun items(): List<ConversationFeedItem> = mirror

    /**
     * Current generation token. Capture before launching a REST fetch and pass
     * back to [replaceMirror] so a stale response from an earlier switch is
     * silently discarded.
     */
    fun currentGeneration(): Int = generation

    /**
     * Force a history refetch outside the session.switched path (Task 3.10 —
     * stream.resumed{recovered:false}). Bumps the generation + arms the gate so
     * current-target entries are buffered. Returns the post-bump generation for
     * the REST fetch + replaceMirror. Mirrors the session.switched bookkeeping
     * without the SdkEvent.SessionSwitched emission (no UI session change here).
     */
    fun bumpForRefetch(sessionId: String? = targetSessionId): Int {
        if (targetSessionId != sessionId) liveTail = emptyList()
        targetSessionId = sessionId
        generation++
        awaitingHistory = true
        log.info("gate-set", mapOf("trigger" to "stream.resumed.refetch", "generation" to generation))
        return generation
    }

    /**
     * Local clear for the "+ new chat" path (bug #1). The gateway clears its own
     * mirror on session.new but emits no client-facing switch/snapshot (the
     * empty-id switched is intentionally ignored), so the app must drop its
     * visible history the instant the user taps "+". Bumps the generation so any
     * in-flight REST fetch from a prior switch is invalidated, resets the mirror
     * to empty, and emits the empty snapshot/update so the UI clears immediately.
     *
     * Does NOT arm [awaitingHistory]: a new chat has no REST history to wait for,
     * and the FIRST entry of the new turn must reach the mirror, not be gated.
     */
    fun clearForNewChat() {
        generation++
        awaitingHistory = false
        awaitingMintHistory = true
        targetSessionId = null
        liveTail = emptyList()
        mirror = emptyList()
        log.info("clear-new-chat", mapOf("generation" to generation))
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    /**
     * Local clear for the user-initiated SWITCH path (Problem 1). Tapping a past
     * chat must drop the CURRENT session's messages immediately and show the
     * loading gate, so the spinner renders over an EMPTY chat — not over stale
     * history that lingers until the REST fetch lands.
     *
     * Clears the mirror and ARMS [awaitingHistory] (so the spinner shows now and
     * any straggler entry from the outgoing session is gated out). The
     * subsequent `session.switched` re-arms the gate, bumps the generation, and
     * launches the REST fetch whose `replaceMirror` fills the target + releases
     * the gate (on success OR on error-clear, so it never wedges). NOT called on
     * the reconnect re-establish path — that uses fireSwitch and must not flash
     * the chat empty.
     */
    fun clearForSwitch() {
        generation++ // Invalidate REST immediately, before the next switch ACK.
        targetSessionId = null
        liveTail = emptyList()
        awaitingHistory = true
        awaitingMintHistory = false
        mirror = emptyList()
        log.info("clear-for-switch")
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    override fun handle(msg: ServerMessage) {
        when (msg) {
            // Forward-compat: a conversation.snapshot from an older gateway version
            // (pre-Task-2.1 or a reconnect that sends one) still hydrates the mirror.
            is ServerMessage.ConversationSnapshot -> onSnapshotFrame(msg)
            is ServerMessage.ConversationEntry -> onEntryFrame(msg)
            is ServerMessage.SessionAttached -> {
                // The SDK validates attachment against the latest route intent before
                // broadcasting. Reconstruction can precede switch ACK / REST launch.
                if (targetSessionId != msg.sessionId) liveTail = emptyList()
                targetSessionId = msg.sessionId
            }
            is ServerMessage.SessionSwitched -> onSessionSwitched(msg)
            is ServerMessage.SessionCreated -> onSessionCreated(msg)
            else -> Unit // not owned by this connector
        }
    }

    /**
     * Replace the conversation mirror with [items] from the REST history fetch.
     * [forGeneration] must equal [currentGeneration]; if not, this response is
     * stale (a faster switch superseded it) and is silently discarded.
     *
     * Always clears [awaitingHistory] even on a generation mismatch would be
     * wrong — only clear when the response is current, to avoid wedging. If
     * this IS stale the gate stays set; the winning (newer) fetch will clear it.
     */
    fun replaceMirror(items: List<ConversationFeedItem>, forGeneration: Int) {
        if (forGeneration != generation) {
            log.info(
                "replaceMirror.stale",
                mapOf("forGeneration" to forGeneration, "current" to generation),
            )
            return
        }
        log.info("replaceMirror", mapOf("count" to items.size, "generation" to generation))
        mirror = liveTail.fold(items.toList(), ::mergeEntry)
        liveTail = emptyList()
        awaitingHistory = false
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    // ── Internal frame handlers ───────────────────────────────────────────────

    private fun onSnapshotFrame(msg: ServerMessage.ConversationSnapshot) {
        log.info("snapshot-legacy", mapOf("count" to msg.items.size))
        replaceMirror(msg.items, generation)
    }

    private fun mergeEntry(items: List<ConversationFeedItem>, item: ConversationFeedItem): List<ConversationFeedItem> {
        val index = if (item.entryId.isNotEmpty()) items.indexOfFirst { it.entryId == item.entryId } else -1
        return if (index >= 0) items.toMutableList().also { it[index] = item } else items + item
    }

    private fun onEntryFrame(msg: ServerMessage.ConversationEntry) {
        val user = msg.item as? ConversationFeedItem.User
        if (targetSessionId != null && user?.sessionId != null && user.sessionId != targetSessionId) return
        // Before target attachment there is no reconstruction authority. During REST loading,
        // require explicit session identity on user receipts; other feed items
        // are already quarantined by SdkLifecycle's attachment fence.
        if (awaitingHistory && (targetSessionId == null || (user != null && user.sessionId != targetSessionId))) return
        // Re-attach the gateway's frame turnId AND replyId onto an assistant entry.
        // turnId suppresses the committed twin while its live bubble reveals; replyId
        // is what groups several committed rows of one ReAct turn back into the single
        // bubble they were streamed as. The item itself now carries replyId too (the
        // gateway stamps it there as of Task 2) — this re-attach is only an OVERRIDE
        // for turnId (always frame-only) and for a frame from a gateway that predates
        // the item-level stamp. No client-side derivation anywhere.
        val item = msg.item
        val enriched =
            if (item is ConversationFeedItem.Assistant && (msg.turnId != null || msg.replyId != null)) {
                item.copy(turnId = msg.turnId ?: item.turnId, replyId = msg.replyId ?: item.replyId)
            } else {
                item
            }
        if (awaitingHistory) {
            liveTail = mergeEntry(liveTail, enriched)
            return
        }
        mirror = mergeEntry(mirror, enriched)
        onEntry?.invoke(enriched)
        onUpdate?.invoke(mirror)
    }

    private fun onSessionSwitched(msg: ServerMessage.SessionSwitched) {
        awaitingMintHistory = false
        requestHistory(msg.sessionId, "session.switched")
        onEvent?.invoke(SdkEvent.SessionSwitched(sessionId = msg.sessionId))
    }

    private fun onSessionCreated(msg: ServerMessage.SessionCreated) {
        if (!awaitingMintHistory) return
        awaitingMintHistory = false
        // Draft admission commits before fan-out attaches this window. Refetching
        // here recovers that first user entry and its pendingId/attachments.
        requestHistory(msg.sessionId, "session.created")
    }

    private fun requestHistory(sessionId: String, trigger: String) {
        if (targetSessionId != sessionId) liveTail = emptyList()
        targetSessionId = sessionId
        generation++
        log.info(
            "gate-set",
            mapOf("trigger" to trigger, "sessionId" to sessionId, "generation" to generation),
        )
        awaitingHistory = true
        // Fire AFTER the bump so the callee receives the post-bump generation.
        onHistoryNeeded?.invoke(sessionId, generation)
    }

    companion object {
        const val CAPABILITY: String = "conversation.history"
    }
}
