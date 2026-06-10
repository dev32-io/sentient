package io.sentient.mobiledata.data

import io.sentient.mobiledata.cache.db.ChatDatabase
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Durable-cache decorator over a [SessionsRepository] (the REST/SDK passthrough).
 *
 * Unlike the active-conversation timeline, the session list is a PULL surface —
 * [SessionsRepository.list] is a one-shot suspend fetch the History VM re-calls on
 * drawer-open + after each mutation, not an observable the decorator can re-expose.
 * So cache-then-refresh is adapted to the pull seam:
 *
 *  • [list] serves the DB cache INSTANTLY when warm (instant-paint-on-launch: the
 *    last list's rows are already persisted before REST returns) and fires a
 *    background refresh on [scope]. On a COLD cache (empty DB) it AWAITS the REST
 *    refresh so the first paint matches today's await-the-network behaviour — no
 *    empty-list flash.
 *  • The refresh write-throughs every REST session (`upsertSession`) AND runs the
 *    smart-async deletion: diff the local id set (`allSessionIds`) against the
 *    server set; any LOCAL id absent server-side was deleted upstream (e.g. Hermes'
 *    90-day cleanup) → `deleteSession` + cascade `deleteConversation` (orphaned
 *    message rows for a gone session waste space). Done in the background, never
 *    blocking the instant paint.
 *  • Local optimistic ops mirror the cache to the user's intent before REST settles:
 *    [delete] removes the session + its messages locally and delegates; [rename]
 *    upserts the new title and delegates; switch / new-chat delegate straight
 *    through (the next `list()` refresh repopulates from REST).
 *
 * Idempotent INSERT OR REPLACE means an unchanged session no-ops; the diff only
 * ever drops locally-stale ids, never server-present ones.
 *
 * **Eventual-consistency note:** an in-flight [refresh] whose REST snapshot predates
 * a local [delete] can transiently re-insert the deleted session; the discrepancy is
 * corrected on the next refresh (next drawer open). At family scale this window is
 * invisible and adding a guard would introduce complexity without measurable benefit.
 */
// Architecture exception: stateful caching decorator behind the stateless SessionsRepository interface — see .claude/rules/mobile-data/repositories.md rationale (mirrors CachingConversationRepository).
class CachingSessionsRepository(
    private val underlying: SessionsRepository,
    db: ChatDatabase,
    private val scope: CoroutineScope,
    // Write/read dispatcher for blocking SQLite ops (cache read + write-through +
    // smart-async delete), off the CPU `Dispatchers.Default` mirrorScope. Injected by
    // the platform owner — `Dispatchers.IO` is not a commonMain API (see [ioDispatcher]).
    private val ioDispatcher: CoroutineDispatcher,
    // Shared CLIENT-INTENT anchor (owned by ChatComponent, read by the conversation
    // decorator). The switch path lands HERE — `switchTo*` carries the target id the
    // client KNOWS at route-open time, before any server echo — so we SET the anchor
    // here to drive the conversation decorator's instant cached paint. New-chat clears
    // it to null (no id minted yet). Default no-op signal keeps existing tests + any
    // caller that doesn't wire the mirror anchor working unchanged.
    private val activeConversationIntent: MutableStateFlow<String?> = MutableStateFlow(null),
) : SessionsRepository {
    private val log = createLogger("data", "caching-sessions")
    private val queries = db.chatDatabaseQueries

    /**
     * Cache-then-refresh over the pull seam. Warm cache → return the persisted rows
     * instantly and refresh in the background; cold cache → await the REST refresh so
     * the first paint is never an empty flash. The list/offset window is applied to
     * the cached rows so the contract (a page of most-recent sessions) holds either way.
     */
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> {
        val cached = readCache(limit, offset)
        if (cached.isNotEmpty()) {
            log.info("cache-hit", mapOf("count" to cached.size))
            scope.launch { refresh() }
            return cached
        }
        log.info("cache-miss", mapOf("reason" to "empty-cache-await-rest"))
        refresh()
        return readCache(limit, offset)
    }

    private suspend fun readCache(limit: Int, offset: Int): List<SessionSummary> =
        withContext(ioDispatcher) {
            queries.allSessions().executeAsList()
                .drop(offset).take(limit).map { it.toSummary() }
        }

    /**
     * Fetch the REST list, write it through to the cache, then smart-async-delete the
     * locally-stale sessions. Fetch a generous window so the diff sees the full server
     * set — a paged window would falsely mark off-page sessions as deleted.
     */
    private suspend fun refresh() {
        val server = runCatching { underlying.list(REFRESH_LIMIT, offset = 0) }
            .getOrElse {
                log.warn("refresh-failed", mapOf("reason" to (it.message ?: "rest-list")))
                return
            }
        writeThrough(server)
        smartAsyncDelete(server)
    }

    private suspend fun writeThrough(server: List<SessionSummary>) {
        withContext(ioDispatcher) {
            server.forEach { queries.upsertSession(it.id, it.title, it.updatedAtMs) }
        }
        log.info("write-through", mapOf("count" to server.size))
    }

    /**
     * Smart-async deletion: any local id not in the server set was deleted upstream →
     * drop it + cascade its messages. The diff runs entirely on [ioDispatcher].
     */
    private suspend fun smartAsyncDelete(server: List<SessionSummary>) {
        val serverIds = server.mapTo(HashSet()) { it.id }
        val stale = withContext(ioDispatcher) {
            queries.allSessionIds().executeAsList().filter { it !in serverIds }
        }
        if (stale.isEmpty()) return
        withContext(ioDispatcher) {
            stale.forEach {
                queries.deleteSession(it)
                queries.deleteConversation(it)
            }
        }
        log.info("smart-async-delete", mapOf("count" to stale.size, "dropped" to stale))
    }

    /** Optimistic local delete (session + its messages) then delegate the REST delete. */
    override suspend fun delete(sessionId: String) {
        withContext(ioDispatcher) {
            queries.deleteSession(sessionId)
            queries.deleteConversation(sessionId)
        }
        log.info("delete.optimistic", mapOf("sessionId" to sessionId))
        underlying.delete(sessionId)
    }

    /** Optimistic local title update then delegate the REST rename. */
    override suspend fun rename(sessionId: String, title: String) {
        val existing = withContext(ioDispatcher) {
            queries.sessionById(sessionId).executeAsOneOrNull()
        }
        if (existing != null) {
            withContext(ioDispatcher) {
                queries.upsertSession(sessionId, title, existing.updated_at)
            }
            log.info("rename.optimistic", mapOf("sessionId" to sessionId))
        } else {
            // Session not in cache — rename always targets a visible session, so this
            // is a defensive fallback. Skip the local upsert to avoid floating a row
            // with 0L updated_at to the bottom of the DESC list.
            log.debug("rename.skip-optimism", mapOf("sessionId" to sessionId, "reason" to "not-in-cache"))
        }
        underlying.rename(sessionId, title)
    }

    // Switch / new-chat are pure delegations for the session LIST — the next list()
    // refresh repopulates the cache from REST. No local upsert here: a freshly-minted
    // session has no title/ts to cache until the server reflects it.
    //
    // CLIENT-INTENT ANCHOR: switch SETS the shared anchor to the target id BEFORE
    // delegating, so the conversation decorator's DB-backed timeline re-subscribes and
    // paints that conversation's cached rows INSTANTLY — driven by the client's switch
    // intent, not awaited from the gateway's `session.switched` echo. New-chat clears
    // the anchor to null (no id minted yet → blank canvas until the live snapshot lands).
    override fun newChatFireAndForget() {
        activeConversationIntent.value = null
        underlying.newChatFireAndForget()
    }

    override fun switchToFireAndForget(sessionId: String) {
        activeConversationIntent.value = sessionId
        underlying.switchToFireAndForget(sessionId)
    }

    override suspend fun switchTo(sessionId: String) {
        activeConversationIntent.value = sessionId
        underlying.switchTo(sessionId)
    }

    override suspend fun newChat(): String {
        activeConversationIntent.value = null
        return underlying.newChat()
    }

    private companion object {
        // Refresh fetches a generous window so the smart-async diff sees the whole
        // server set; a paged window would misread off-page sessions as deleted.
        // Scale assumption: the server won't accumulate >1000 non-expired sessions
        // per user at family scale — Hermes' 90-day cleanup keeps the real count
        // well below ~100 in practice. Revisit if multi-user or export scenarios
        // change the scale.
        const val REFRESH_LIMIT = 1000
    }
}
