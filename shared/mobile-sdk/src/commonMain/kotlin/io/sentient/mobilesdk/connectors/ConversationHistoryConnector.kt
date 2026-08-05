// ---------------------------------------------------------------------------
// ConversationHistoryConnector — session-scoped read-only mirror of the
// gateway's ConversationHistory.
//
// Mirrors web-sdk's conversation-history-connector.ts post-Task-2.5 shape:
//   capability = "conversation.history"  (status observer)
//
//   conversation.entry    → APPEND to the mirror, fire onEntry + onUpdate,
//                           UNLESS awaitingHistory (straggler from prior
//                           generation → DROP).
//   session.switched      → increment generation; set awaitingHistory gate;
//                           fire onHistoryNeeded(sessionId, generation) + onEvent.
//   replaceMirror(items)  → REPLACE the mirror with REST history, release the
//                           gate, fire onSnapshot + onUpdate.
//
// The gateway no longer sends conversation.snapshot on session.switched
// (Task 2.1). History is loaded via REST getMessages. The gate semantics are
// identical: stragglers between session.switched and the REST response drop;
// the gate clears on replaceMirror success (or on a deliberate clear-with-empty
// on REST error so the connector never wedges).
//
// Stale-switch guard: a generation counter increments on every session.switched.
// onHistoryNeeded fires AFTER the increment so the generation token it carries
// is the POST-bump value — the same value replaceMirror must match. This
// eliminates the ordering dependency between router.route and onSessionAnchored
// that caused the generation mismatch bug (Task 2.6 fix).
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher
// and calls replaceMirror from the SDK scope. The mutable mirror + gate are
// owned here.
// ---------------------------------------------------------------------------
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
     * stragglers drop, then returns the post-bump generation the caller passes to
     * the REST fetch + replaceMirror. Mirrors the session.switched bookkeeping
     * without the SdkEvent.SessionSwitched emission (no UI session change here).
     */
    fun bumpForRefetch(): Int {
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
        awaitingHistory = true
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
            is ServerMessage.SessionSwitched -> onSessionSwitched(msg)
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
        mirror = items.toList()
        awaitingHistory = false
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    // ── Internal frame handlers ───────────────────────────────────────────────

    private fun onSnapshotFrame(msg: ServerMessage.ConversationSnapshot) {
        log.info("snapshot-legacy", mapOf("count" to msg.items.size))
        mirror = msg.items.toList()
        awaitingHistory = false
        onSnapshot?.invoke(mirror)
        onUpdate?.invoke(mirror)
    }

    private fun onEntryFrame(msg: ServerMessage.ConversationEntry) {
        if (awaitingHistory) {
            log.debug("entry-dropped", mapOf("reason" to "awaiting-history", "ts" to msg.item.ts))
            return
        }
        // Re-attach the gateway's frame turnId AND messageId onto an assistant entry.
        // turnId suppresses the committed twin while its live bubble reveals; messageId
        // is what groups several committed rows of one ReAct turn back into the single
        // bubble they were streamed as. The wire item strips both; the frame carries
        // them. No client-side derivation anywhere.
        val item = msg.item
        val enriched =
            if (item is ConversationFeedItem.Assistant && (msg.turnId != null || msg.messageId != null)) {
                item.copy(turnId = msg.turnId ?: item.turnId, messageId = msg.messageId ?: item.messageId)
            } else {
                item
            }
        // Dedup by stable entryId: a re-delivered entry (e.g. a committed entry
        // replayed on resume) updates in place instead of double-appending.
        // Empty entryId (UNKNOWN_ENTRY_ID) has no identity → never deduped.
        val existingIdx =
            if (enriched.entryId.isNotEmpty()) mirror.indexOfFirst { it.entryId == enriched.entryId } else -1
        mirror =
            if (existingIdx >= 0) mirror.toMutableList().also { it[existingIdx] = enriched }
            else mirror + enriched
        log.info(
            "entry",
            mapOf(
                "entryId" to enriched.entryId,
                "ts" to enriched.ts,
                "turnId" to (msg.turnId ?: "-"),
                "messageId" to (msg.messageId ?: "-"),
                "deduped" to (existingIdx >= 0),
                "size" to mirror.size,
            ),
        )
        onEntry?.invoke(enriched)
        onUpdate?.invoke(mirror)
    }

    private fun onSessionSwitched(msg: ServerMessage.SessionSwitched) {
        generation++
        log.info(
            "gate-set",
            mapOf("trigger" to "session.switched", "sessionId" to msg.sessionId, "generation" to generation),
        )
        awaitingHistory = true
        // Fire AFTER the bump so the callee receives the post-bump generation.
        // This ensures the REST fetch launched in the callback uses the same
        // generation token that replaceMirror will later validate against.
        onHistoryNeeded?.invoke(msg.sessionId, generation)
        onEvent?.invoke(SdkEvent.SessionSwitched(sessionId = msg.sessionId))
    }

    companion object {
        const val CAPABILITY: String = "conversation.history"
    }
}
