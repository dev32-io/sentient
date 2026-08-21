// ---------------------------------------------------------------------------
// HistoryViewModel — drives the History drawer's session list + search state.
//
// Loads the session list from the User/Connection-scoped ChatComponent's
// observeSessions usecase (suspend list fetch); rename/delete route through the
// same component. It NO LONGER switches conversation or starts a new chat — those
// are NAVIGATIONS owned by the nav layer (the drawer's onSelect/onNewChat callbacks
// navigate to chat(sessionId)). So this VM is read + mutate (rename/delete) only.
//
// Search mirrors the webui semantics but filters CLIENT-SIDE (the SDK does not
// expose sessions.search) — a substring match over the loaded title list.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.di.UserSessionManager
import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SessionRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Page size for the session-list fetch. The drawer shows the most-recent chats. */
private const val SESSIONS_PAGE_LIMIT = 100

/** Everything the History drawer renders. Immutable; replaced wholesale on change. */
data class HistoryUiState(
    val sessions: List<SessionRow> = emptyList(),
    val query: String = "",
    val loading: Boolean = false,
    val error: String? = null,
) {
    /** Rows after the client-side search filter (substring over title). */
    val visible: List<SessionRow>
        get() {
            val q = query.trim()
            if (q.isEmpty()) return sessions
            return sessions.filter { it.title.contains(q, ignoreCase = true) }
        }

    val isSearching: Boolean get() = query.trim().isNotEmpty()

    /**
     * True when the load failed and there are NO rows to fall back on — the list
     * area is replaced by the SessionsErrorEmpty affordance. Guarded on `!loading`.
     */
    val showsErrorEmpty: Boolean get() = error != null && visible.isEmpty() && !loading

    /** True when a re-fetch failed but rows are still loaded — a thin stale banner. */
    val showsStaleBanner: Boolean get() = error != null && visible.isNotEmpty()
}

/** Maps a [SessionSummary] to the [SessionRow] shape used by the drawer. */
private fun SessionSummary.toSessionRow(): SessionRow = SessionRow(
    sessionId = id,
    title = title,
    startedAt = 0L,
    lastActiveAt = updatedAtMs,
    messageCount = 0,
    isActive = false,
)

/**
 * Holds the session list for the History drawer. Reads + rename/delete route through
 * the User/Connection-scoped [UserSessionManager.component]. Conversation selection /
 * new-chat are navigations handled by the host, not commands here.
 */
class HistoryViewModel(
    userSession: UserSessionManager,
) : ViewModel() {
    private val log = createLogger("android", "history-viewmodel")
    private val component = userSession.component()

    private val _state = MutableStateFlow(HistoryUiState())
    val state: StateFlow<HistoryUiState> = _state.asStateFlow()

    /** Re-query the session list. Call on drawer-open + after any mutation. */
    fun refresh() {
        log.info("refresh")
        viewModelScope.launch { loadSessions() }
    }

    fun setQuery(q: String) {
        _state.value = _state.value.copy(query = q)
    }

    fun renameSession(sessionId: String, title: String) {
        log.info("renameSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch {
            runCatching { component.renameSession(sessionId, title) }
                .onFailureNonCancellation { warn("rename-failed", it, mapOf("sessionId" to sessionId)) }
            loadSessions()
        }
    }

    fun deleteSession(sessionId: String) {
        log.info("deleteSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch {
            runCatching { component.deleteSession(sessionId) }
                .onFailureNonCancellation { warn("delete-failed", it, mapOf("sessionId" to sessionId)) }
            loadSessions()
        }
    }

    private suspend fun loadSessions() {
        _state.value = _state.value.copy(loading = true, error = null)
        runCatching { component.observeSessions(limit = SESSIONS_PAGE_LIMIT, offset = 0) }
            .onSuccess { summaries ->
                val rows = summaries.map { it.toSessionRow() }
                log.info("loaded", mapOf("count" to rows.size))
                _state.value = _state.value.copy(sessions = rows, loading = false, error = null)
            }
            .onFailureNonCancellation {
                warn("load-failed", it)
                _state.value = _state.value.copy(
                    loading = false,
                    error = "Couldn't load chats.",
                )
            }
    }

    private fun warn(event: String, _e: Throwable, extra: Map<String, Any?> = emptyMap()) {
        log.warn(event, extra + mapOf("code" to "history-operation-failure"))
    }
}

/**
 * Like [Result.onFailure] but rethrows [CancellationException] so a cancelled
 * viewModelScope (ViewModel cleared / drawer dismissed) propagates instead of
 * being swallowed + logged as a spurious failure.
 */
private inline fun <T> Result<T>.onFailureNonCancellation(action: (Throwable) -> Unit): Result<T> =
    onFailure { if (it is CancellationException) throw it else action(it) }
