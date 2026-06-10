@file:OptIn(ExperimentalCoroutinesApi::class)

package io.sentient.mobiledata.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import io.sentient.mobiledata.cache.db.ChatDatabase
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SdkEvent
import io.sentient.mobilesdk.sdk.ChatMessage
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Durable-mirror decorator over a [ConversationRepository] (the SDK passthrough).
 *
 * The SDK exposes ONE fused [timeline] (REST replaceMirror + live appends merged)
 * and [ChatMessage] has no conversationId, so the device mirror cannot be a clean
 * two-seam REST-vs-live split. This decorator folds the fused timeline into the
 * local DB and serves an instant cached paint:
 *
 *  • timeline (the value the VM collects) is DB-BACKED — `messagesFor(activeConv)`
 *    mapped to [ChatMessage]. The DB anchor is the CLIENT's switch INTENT
 *    ([activeConversationIntent]), SET by `CachingSessionsRepository.switchTo*` at
 *    the moment the route opens — BEFORE any server echo, before the SDK connects.
 *    So on a COLD launch the persisted rows of the route's conversation paint
 *    INSTANTLY: the anchor is known from the client, not awaited from a
 *    `session.switched` round-trip. THIS is instant-paint-on-launch.
 *  • A separate collector FEEDS the DB from the SDK surfaces:
 *      - SessionSwitched(nonEmpty) → arm a one-shot REPLACE for that conversation.
 *        The live echo is the gateway's authoritative reload signal; the actual
 *        delete is deferred to the next timeline snapshot so it can run ATOMICALLY
 *        with the REST reload insert (see below) — no empty flash on the painted
 *        cached rows.
 *      - each fused-timeline snapshot for the active conversation → write it
 *        through. The FIRST NON-EMPTY snapshot after an armed switch runs as a
 *        single `transaction { }`: deleteConversation THEN upsert the new set, so
 *        the reactive `messagesFor` flow emits ONCE (cached rows → REST rows) with
 *        no intermediate emptyList. The delete is gated on a non-empty snapshot
 *        because a switch passes through an empty `replaceMirror(emptyList())`
 *        intermediate while awaiting REST — deleting on THAT would flash the
 *        painted cached rows to empty. Later snapshots are plain idempotent
 *        upserts. Only entries with a NON-EMPTY entryId (committed) are written;
 *        the in-flight pre-commit bubble (empty entryId) is skipped — it persists
 *        once committed. seq = list position.
 *
 * Idempotent upsert-by-entryId means unchanged rows no-op and per-token churn is
 * avoided. entryId namespace is opaque here (UUID for live, positional
 * `conversationId:index` for REST) — we store whatever the timeline carries. The
 * live UUID and positional REST namespaces coexist for live appends after the
 * replace; the REST set is authoritative for the replaced baseline.
 *
 * [liveEvents] and [send] pass straight through to the underlying repository.
 */
// Architecture exception: stateful caching decorator behind the stateless ConversationRepository interface — see .claude/rules/mobile-data/repositories.md rationale.
class CachingConversationRepository(
    private val underlying: ConversationRepository,
    db: ChatDatabase,
    scope: CoroutineScope,
    // Shared CLIENT-INTENT anchor: the active conversation id, SET by the sessions
    // decorator's switch path (route open) and READ here as the DB-timeline anchor.
    // Owned by ChatComponent so both decorators observe the same signal. This is the
    // seam that lets the cached paint fire from the client's switch intent — before
    // the server's `session.switched` echo, before the SDK connects.
    private val activeConversationIntent: StateFlow<String?>,
    // Read dispatcher: where the DB-backed timeline query runs (CPU-cheap mapping).
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    // Write dispatcher: where blocking SQLite WRITES (atomic replace + write-through
    // upsert) run, off the CPU `Dispatchers.Default` scope. Injected by the platform
    // owner — `Dispatchers.IO` is not a commonMain API (see [ioDispatcher]).
    private val ioDispatcher: CoroutineDispatcher,
) : ConversationRepository {
    private val log = createLogger("data", "caching-conversation")
    private val queries = db.chatDatabaseQueries

    // One-shot replace arming: the conversation id whose next timeline snapshot must
    // run as an atomic delete+insert (the gateway's reload), or null when no replace
    // is pending. Set from the live SessionSwitched echo, consumed by writeThrough.
    private var pendingReplaceFor: String? = null

    override val liveEvents: SharedFlow<SdkEvent> get() = underlying.liveEvents
    override fun send(text: String, pendingId: String) = underlying.send(text, pendingId)

    /**
     * DB-backed committed history for the active conversation. Re-subscribes to the
     * right `messagesFor` query whenever the CLIENT-INTENT anchor changes; emits the
     * persisted rows mapped back to [ChatMessage]. Started Eagerly so the cached rows
     * paint the instant the VM collects (and so the feed collector below has a value).
     */
    override val timeline: StateFlow<List<ChatMessage>> =
        activeConversationIntent
            .flatMapLatest { convId -> dbTimelineFor(convId, dispatcher) }
            .stateIn(scope, SharingStarted.Eagerly, emptyList())

    init {
        scope.launch { collectSwitches() }
        scope.launch { collectTimelineWriteThrough() }
    }

    private fun dbTimelineFor(convId: String?, dispatcher: CoroutineDispatcher): Flow<List<ChatMessage>> {
        if (convId == null) return flowOf(emptyList())
        return queries.messagesFor(convId).asFlow().mapToList(dispatcher)
            .map { rows -> rows.map { it.toChatMessage() } }
    }

    /**
     * SessionSwitched(nonEmpty) → ARM a one-shot atomic replace for that conversation.
     * The gateway's `session.switched` echo is the authoritative reload signal: the
     * REST snapshot is about to replace the conversation's rows. We do NOT delete here
     * (a bare delete would flash the already-painted cached rows to empty before the
     * REST rows land) — the delete is deferred into the next write-through snapshot so
     * it runs in the SAME transaction as the reload insert.
     */
    private suspend fun collectSwitches() {
        underlying.liveEvents
            .map { (it as? SdkEvent.SessionSwitched)?.sessionId }
            .onEach { id ->
                if (id.isNullOrEmpty()) return@onEach
                log.info("switch.arm-replace", mapOf("conversationId" to id))
                pendingReplaceFor = id
            }
            .collect { }
    }

    /**
     * Write-through: on each fused-timeline snapshot for the active conversation,
     * upsert every committed (non-empty entryId) entry. seq = list position.
     */
    private suspend fun collectTimelineWriteThrough() {
        // underlying.timeline is a StateFlow — it already conflates duplicate snapshots,
        // so no distinctUntilChanged (which is a no-op on StateFlow). Idempotent
        // upsert-by-entryId absorbs any redundant re-emit that does slip through.
        underlying.timeline.collect { snapshot -> writeThrough(snapshot) }
    }

    private suspend fun writeThrough(snapshot: List<ChatMessage>) {
        // Anchor from the CLIENT intent — the same signal that drives the DB paint —
        // so write-through targets exactly the painted conversation.
        val convId = activeConversationIntent.value ?: return
        val committed = snapshot.count { it.entryId.isNotEmpty() }
        // Consume a pending replace ONLY on the FIRST NON-EMPTY snapshot for the active
        // conversation. On a switch the SDK emits [stale] → [] (replaceMirror(emptyList)
        // while awaiting REST) → [REST items]. Deleting on the empty intermediate would
        // wipe the painted cached rows in one transaction and re-insert in a LATER one —
        // an empty flash. Gating the delete on a non-empty snapshot makes the
        // delete+insert genuinely atomic against the REST reload: cached rows survive
        // the empty window, then swap to REST rows in a single transaction.
        val replace = pendingReplaceFor == convId && committed > 0
        // Nothing to write and no replace to apply (e.g. the empty intermediate snapshot
        // mid-switch) → skip the DB round-trip entirely; the painted cached rows stay put.
        if (committed == 0 && !replace) return
        if (replace) pendingReplaceFor = null
        withContext(ioDispatcher) {
            // Single transaction → the reactive `messagesFor` notifier fires ONCE on
            // commit: cached rows → REST rows, never an empty intermediate emission.
            queries.transaction {
                if (replace) queries.deleteConversation(convId)
                persistCommitted(snapshot, convId)
            }
        }
        log.info(
            "write-through",
            mapOf(
                "conversationId" to convId,
                "committed" to committed,
                "snapshot" to snapshot.size,
                "replace" to replace,
            ),
        )
    }

    /**
     * Upsert every committed entry. `seq = index` is safe because the SDK [timeline]
     * is committed-only (StateDeriver.deriveTimeline passes inflight=null + drops empty
     * entries), so no in-flight bubble shifts the index; the empty-entryId skip below
     * is belt-and-braces against a future upstream change.
     */
    private fun persistCommitted(snapshot: List<ChatMessage>, convId: String) {
        snapshot.forEachIndexed { index, message ->
            if (message.entryId.isEmpty()) return@forEachIndexed
            val row = message.toRow(conversationId = convId, seq = index.toLong())
            queries.upsertMessage(
                entry_id = row.entry_id,
                conversation_id = row.conversation_id,
                seq = row.seq,
                role = row.role,
                content = row.content,
                ts = row.ts,
                cutoff_kind = row.cutoff_kind,
            )
        }
    }
}
