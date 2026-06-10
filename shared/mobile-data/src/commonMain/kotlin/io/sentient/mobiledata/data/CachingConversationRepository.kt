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
import kotlinx.coroutines.flow.MutableStateFlow
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
 * two-seam REST-vs-live split. This decorator tracks the active conversation from
 * the SDK's switch signal and folds the fused timeline into the local DB:
 *
 *  • timeline (the value the VM collects) is DB-BACKED — `messagesFor(currentConv)`
 *    mapped to [ChatMessage]. THIS is instant-paint-on-launch: the last session's
 *    rows are already in the DB before the SDK reconnects.
 *  • A separate collector FEEDS the DB from the SDK surfaces:
 *      - SessionSwitched(nonEmpty) → set currentConv AND delete its rows
 *        (replace-on-reload; the incoming REST reload + live entries repopulate).
 *      - each fused-timeline snapshot → upsert every entry with a NON-EMPTY
 *        entryId (committed). The in-flight pre-commit bubble (empty entryId) is
 *        skipped — it persists once committed. seq = list position.
 *
 * Idempotent upsert-by-entryId means unchanged rows no-op and per-token churn is
 * avoided. entryId namespace is opaque here (UUID for live, positional
 * `conversationId:index` for REST) — we store whatever the timeline carries.
 *
 * [liveEvents] and [send] pass straight through to the underlying repository.
 */
// Architecture exception: stateful caching decorator behind the stateless ConversationRepository interface — see .claude/rules/mobile-data/repositories.md rationale.
class CachingConversationRepository(
    private val underlying: ConversationRepository,
    db: ChatDatabase,
    scope: CoroutineScope,
    // Read dispatcher: where the DB-backed timeline query runs (CPU-cheap mapping).
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
    // Write dispatcher: where blocking SQLite WRITES (delete-on-switch + write-through
    // upsert) run, off the CPU `Dispatchers.Default` scope. Injected by the platform
    // owner — `Dispatchers.IO` is not a commonMain API (see [ioDispatcher]).
    private val ioDispatcher: CoroutineDispatcher,
) : ConversationRepository {
    private val log = createLogger("data", "caching-conversation")
    private val queries = db.chatDatabaseQueries

    /** The active conversation id, anchored from SessionSwitched(nonEmpty). */
    private val currentConversationId = MutableStateFlow<String?>(null)

    override val liveEvents: SharedFlow<SdkEvent> get() = underlying.liveEvents
    override fun send(text: String, pendingId: String) = underlying.send(text, pendingId)

    /**
     * DB-backed committed history for the active conversation. Re-subscribes to the
     * right `messagesFor` query whenever the active conversation changes; emits the
     * persisted rows mapped back to [ChatMessage]. Started Eagerly so the cached rows
     * paint the instant the VM collects (and so the feed collector below has a value).
     */
    override val timeline: StateFlow<List<ChatMessage>> =
        currentConversationId
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

    /** SessionSwitched(nonEmpty) → anchor the conversation AND clear its stale rows. */
    private suspend fun collectSwitches() {
        underlying.liveEvents
            .map { (it as? SdkEvent.SessionSwitched)?.sessionId }
            .onEach { id ->
                if (id.isNullOrEmpty()) return@onEach
                log.info("switch.replace-on-reload", mapOf("conversationId" to id))
                // Delete BEFORE re-subscribing: clear the stale rows first, then anchor
                // the conversation so `flatMapLatest` re-subscribes to an already-cleared
                // table — no intermediate phantom paint of stale-then-deleted rows.
                withContext(ioDispatcher) { queries.deleteConversation(id) }
                currentConversationId.value = id
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
        val convId = currentConversationId.value ?: return
        val committed = snapshot.count { it.entryId.isNotEmpty() }
        withContext(ioDispatcher) {
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
        if (committed > 0) {
            log.info(
                "write-through",
                mapOf("conversationId" to convId, "committed" to committed, "snapshot" to snapshot.size),
            )
        }
    }
}
