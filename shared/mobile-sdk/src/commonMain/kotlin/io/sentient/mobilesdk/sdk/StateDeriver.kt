// ---------------------------------------------------------------------------
// StateDeriver — folds the connector slices into the split observable surfaces:
//   deriveConnection() → ConnectionState (transport + voice axis)
//   deriveTimeline()   → List<ChatMessage> (committed history, no streaming bubble)
//
// The orchestrator holds ONE StateDeriver. Each connector callback updates a
// slice here, then calls deriveConnection()/deriveTimeline() and emits on the
// respective StateFlow. Native UIs read ConnectionState or the timeline directly.
//
// messages: mirrors web-sdk deriveMessages (cycle-helpers.ts) — committed
// user/assistant feed items fold to ChatMessage rows, committed TOOL items fold
// to tool TILES on the row that follows them, and trigger entries are
// Phase-2-ignored. cutoffKind comes off the assistant entry's cutoff.
//
// Pure + synchronous: no coroutines, no platform types, no logging (the
// orchestrator logs the integration trail; this is a value transform).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.connectors.InFlightMessage
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.ConversationFeedItem
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.Clock

/**
 * Holds the connector-owned slices and projects them onto the split surfaces.
 *
 * Single-threaded: the orchestrator mutates slices and calls [deriveConnection]/
 * [deriveTimeline] from one dispatcher. Each setter returns Unit.
 *
 * @param clock Injected wall-clock used to stamp the live streaming bubble's ts
 *   so it sorts after committed entries (mirrors web-sdk's Date.now()).
 */
class StateDeriver(private val clock: Clock) {
    var status: SdkStatus = SdkStatus.DISCONNECTED
    var feed: List<ConversationFeedItem> = emptyList()

    /** Live in-flight buffer for the streaming bubble. */
    var inflight: InFlightMessage? = null

    var transcript: String = ""
    var cognition: CognitionState = CognitionState.IDLE
    var voiceMode: VoiceMode = VoiceMode.OFF
    var prefs: AudioPreferences = AudioPreferences.DEFAULT
    var tasks: List<TaskSnapshotItem> = emptyList()
    var isSpeaking: Boolean = false
    var audioState: AudioState = AudioState.INACTIVE
    var hasSession: Boolean = false
    var connectionLost: Boolean = false
    var authExpired: Boolean = false
    var lastTurnError: Boolean = false

    /**
     * Set the committed feed, clearing the live STT [transcript] when a speech
     * user entry whose content matches the current preview has committed.
     *
     * Mirrors web-sdk use-voice-client.ts: once the finalized speech entry lands
     * in history, the live preview is stale (the utterance is now committed) and
     * must not linger as a duplicate bubble. Channel-scoped to "speech" so a
     * text.input commit never clears a voice preview.
     *
     * Each committed Assistant entry already carries its gateway turnId (the
     * history connector re-attaches the frame turnId), so the live-bubble
     * suppression + the LIVE tool merge read it straight off the item — no
     * stamping. A committed TOOL entry has no turnId on the wire at all; its
     * tile is placed by feed order instead (see the tool-tile header below).
     */
    fun applyFeed(items: List<ConversationFeedItem>) {
        feed = items
        if (transcript.isEmpty()) return
        val lastSpeechUser = items.asReversed().firstOrNull {
            it is ConversationFeedItem.User && it.channel == SPEECH_CHANNEL
        } as ConversationFeedItem.User?
        if (lastSpeechUser != null && lastSpeechUser.content == transcript) transcript = ""
    }

    /** Project the connection-axis slice (status, session, voice, audio). */
    fun deriveConnection(): ConnectionState = ConnectionState(
        status = status,
        hasSession = hasSession,
        connectionLost = connectionLost,
        authExpired = authExpired,
        prefs = prefs,
        voiceMode = voiceMode,
        isSpeaking = isSpeaking,
        audioState = audioState,
        cognition = cognition,
    )

    /**
     * Project committed-only messages (no live in-flight bubble).
     * Used by the timeline StateFlow — consumers that want a stable list of
     * committed entries without the streaming noise.
     */
    fun deriveTimeline(): List<ChatMessage> =
        deriveMessages(feed, inflight = null, clock.nowMs(), tasks)
}

// ---------------------------------------------------------------------------
// Tool tiles — two sources, one rendered strip.
//
// A tool call reaches this client TWICE: live as `turn.tool.update`
// (TaskStatusConnector) while it runs, and committed as a kind:"tool" feed item
// once the gateway settles it. Only the committed one survives a reload, so a
// timeline rebuilt from `conversation.snapshot` / REST history must derive tiles
// too — otherwise `render(replay) == render(live)` (spec §3.2 Invariant B) holds
// on the wire and fails at the RENDERED layer, which is the layer the reload
// oracle reads. Dropping the committed item is what made a reloaded mobile chat
// show no tool pills at all.
//
// THE LIVE/COMMITTED JOIN IS POSITIONAL PER TURN, AND THAT IS THE SAME
// COMPROMISE web-sdk MAKES — read cycle-helpers.ts's header before changing it.
// The two frames share no tool-call id: the committed item's only id is its
// gateway `entryId` (the wire deliberately strips tool plumbing from the ITEM —
// shared/protocol/src/conversation.ts), while the live row carries the
// provider's `toolCallId`. What they share is the gateway's dispatch ORDER. So
// a turn's committed tiles are its first N calls and the live list's tail beyond
// N is the calls not yet committed. It rests on react-loop.ts dispatching a
// turn's calls strictly one at a time; make that concurrent and this desyncs.
//
// TILE IDENTITY IS NEVER POSITIONAL. A tile is keyed by a gateway-owned id —
// `entryId` for a committed tile, `toolCallId` for a live one — and the merge
// dedups on that key alone. Positions decide only which live tiles are already
// on screen, never which tile is which.
//
// Placement is feed order: a committed tile anchors to the assistant bubble that
// FOLLOWS it (the reply its result fed) and never crosses the next user entry.
// Live tiles anchor to their turn's LAST bubble — attaching them to every bubble
// of the turn would repeat a pill once per ReAct narration entry, which no
// replay can reproduce.
// ---------------------------------------------------------------------------

/**
 * Fold committed feed items + the live in-flight buffer into the chat list.
 * Mirrors web-sdk deriveMessages (cycle-helpers.ts): User + Assistant entries
 * render as rows, Tool entries render as TILES on the row that follows them, and
 * Trigger entries are Phase-2-ignored. Empty user / empty-non-cutoff assistant
 * entries are dropped too (barge-in markers / pre-token placeholders that don't
 * render). Committed entries first, the streaming bubble last.
 *
 * @param tasks Live tool rows; the ones a turn has not committed yet are merged
 *   onto that turn's last bubble.
 */
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
    tasks: List<TaskSnapshotItem> = emptyList(),
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    // Tiles of the turn being read; they anchor to the next bubble that follows.
    var pendingTools = emptyList<TaskSnapshotItem>()
    for (item in feed) {
        if (item is ConversationFeedItem.Tool) {
            pendingTools = pendingTools + committedTile(item)
            continue
        }
        // A user entry closes the previous turn: tiles still waiting found no
        // reply to anchor to and must not cross the boundary.
        if (item is ConversationFeedItem.User) pendingTools = emptyList()
        val msg = committedMessage(item) ?: continue
        if (msg.role != ROLE_ASSISTANT) {
            out.add(msg)
            continue
        }
        out.add(msg.copy(tools = pendingTools))
        pendingTools = emptyList()
    }
    if (inflight != null) {
        out.add(
            ChatMessage(
                ts = nowMs,
                role = ROLE_ASSISTANT,
                content = inflight.text,
                streaming = true,
                turnId = inflight.turnId,
                tools = pendingTools,
            ),
        )
    }
    return attachLiveTools(out, tasks)
}

private fun committedMessage(item: ConversationFeedItem): ChatMessage? = when (item) {
    is ConversationFeedItem.User ->
        if (item.content.isEmpty()) null
        else ChatMessage(
            ts = item.ts,
            role = ROLE_USER,
            content = item.content,
            pendingId = item.pendingId,
            entryId = item.entryId,
        )

    is ConversationFeedItem.Assistant ->
        if (item.content.isEmpty() && item.cutoff == null) null
        else ChatMessage(
            ts = item.ts,
            role = ROLE_ASSISTANT,
            content = item.content,
            cutoffKind = item.cutoff?.kind,
            // turnId is the gateway-owned join key carried on the entry (re-attached
            // from the conversation.entry frame by the history connector). Read it
            // directly — no client-side text-match/ts-window derivation.
            turnId = item.turnId,
            entryId = item.entryId,
        )

    // Tool items are tiles, handled by the caller's walk; trigger entries are
    // Phase-2 sensor events.
    is ConversationFeedItem.Tool -> null
    is ConversationFeedItem.Trigger -> null
}

/**
 * A committed kind:"tool" entry as a tile. `toolCallId` carries the gateway's
 * `entryId` — stable across the live entry and every later snapshot, so the
 * merge can dedup on it. `turnId` stays [NO_TURN_ID]: the wire strips it from
 * the ITEM, and deriving one from feed position would be the client inventing a
 * gateway id. `argsPreview` stays empty because a committed item carries the
 * tool's RESULT (`summary`), never its arguments — feeding the result to the
 * field the UI labels "arguments" is the bug d077156 fixed on web.
 */
private fun committedTile(item: ConversationFeedItem.Tool): TaskSnapshotItem = TaskSnapshotItem(
    toolCallId = item.entryId,
    toolName = item.toolName,
    turnId = NO_TURN_ID,
    status = COMMITTED_TOOL_STATUS[item.status] ?: STATUS_DONE,
    argsPreview = "",
    startedAtMs = item.ts,
)

/** A turn's anchor bubble (its last) and how many tiles it has already committed
 *  across ALL of its bubbles — a ReAct turn narrates more than once. */
private class TurnAnchors {
    val indexByTurnId = HashMap<String, Int>()
    val committedByTurnId = HashMap<String, Int>()
}

private fun turnAnchors(messages: List<ChatMessage>): TurnAnchors {
    val anchors = TurnAnchors()
    messages.forEachIndexed { index, msg ->
        val turnId = msg.turnId
        if (msg.role != ROLE_ASSISTANT || turnId == null) return@forEachIndexed
        anchors.indexByTurnId[turnId] = index
        anchors.committedByTurnId[turnId] = (anchors.committedByTurnId[turnId] ?: 0) + msg.tools.size
    }
    return anchors
}

/**
 * Merge the live rows a turn has NOT committed yet onto that turn's LAST bubble.
 * Both lists are in gateway dispatch order, so a turn's first N live rows are
 * exactly the N tiles already anchored from its committed entries; only the tail
 * beyond N is still live-only. Empty at every turn boundary — which is what makes
 * the rendered strip converge with a reload.
 *
 * A live list SHORTER than the turn's committed count cannot be aligned at all
 * (frames the client lost and the gateway will not resend). `drop` then yields
 * nothing, keeping the committed tiles — the choice that cannot render one call
 * twice, since the two sources' ids differ.
 */
private fun attachLiveTools(messages: List<ChatMessage>, tasks: List<TaskSnapshotItem>): List<ChatMessage> {
    if (tasks.isEmpty()) return messages
    val anchors = turnAnchors(messages)
    if (anchors.indexByTurnId.isEmpty()) return messages
    return messages.mapIndexed { index, msg ->
        val turnId = msg.turnId ?: return@mapIndexed msg
        if (anchors.indexByTurnId[turnId] != index) return@mapIndexed msg
        val committedCount = anchors.committedByTurnId[turnId] ?: 0
        val live = tasks.filter { it.turnId == turnId }.sortedBy { it.startedAtMs }.drop(committedCount)
        if (live.isEmpty()) msg else msg.copy(tools = mergeTiles(msg.tools, live))
    }
}

/** Dedup by tile id (a gateway-owned id, never a position), chronological order. */
private fun mergeTiles(committed: List<TaskSnapshotItem>, live: List<TaskSnapshotItem>): List<TaskSnapshotItem> {
    val byId = LinkedHashMap<String, TaskSnapshotItem>()
    for (tile in committed + live) byId[tile.toolCallId] = tile
    return byId.values.sortedBy { it.startedAtMs }
}

/**
 * Committed tool entries speak the feed's status union; the live row speaks the
 * loop's. Map committed → live so a replayed tile renders with the same pill as
 * the live tile it stands in for. `cancelled` is the feed's word for "no
 * tool_result was ever committed" (the turn ended first, or it was a background
 * dispatch settling later as its own trigger entry) — the live row for exactly
 * those calls is still "running".
 */
private val COMMITTED_TOOL_STATUS = mapOf(
    "finished" to "done",
    "failed" to "error",
    "cancelled" to "running",
)

/** Fallback for a status a newer gateway added: the round trip is over either
 *  way, so render a settled pill rather than a permanently spinning one. */
private const val STATUS_DONE = "done"

/** Turn id for a committed tile: the wire strips turnId from the tool ITEM, so
 *  there is none to read. Cannot collide with a live row's turnId, which is why
 *  a replayed feed's tiles are always kept. */
private const val NO_TURN_ID = ""

private const val SPEECH_CHANNEL = "speech"
private const val ROLE_USER = "user"
private const val ROLE_ASSISTANT = "assistant"
