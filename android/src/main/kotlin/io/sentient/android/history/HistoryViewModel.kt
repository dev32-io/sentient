// ---------------------------------------------------------------------------
// HistoryViewModel — drives the History drawer's session list + search state.
//
// Loads the session list from HistoryRepository (cache-then-refresh via
// HistoryRepository.load() — emits Loading(cached) immediately, then
// Success/Failure from the live fetch). Mutations (switch/rename/delete/new)
// route through the injected SDK provider so they share the chat-scoped session.
//
// Cache-then-refresh policy:
//   - On drawer open, load() emits the cached list instantly (no spinner flash),
//     then fires the live fetch. The stale banner appears if refresh fails but the
//     cache is non-empty; SessionsErrorEmpty if cache is also empty.
//
// Search mirrors the webui semantics but filters CLIENT-SIDE (SentientSdk does
// not expose sessions.search) — a substring match over the loaded title list.
//
// This is the Android UI app's own MVI-shaped state holder (android-architecture
// rule): UiState data class + one suspend mutation surface. It is NOT a second
// state machine over the SDK — the SDK owns no session-list surface, so the
// list lives here, fetched on demand.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.repository.HistoryRepository
import io.sentient.mobiledata.repository.SessionRowData
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

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
     * area is replaced by the SessionsErrorEmpty affordance. Guarded on `!loading`
     * so the in-flight spinner case isn't pre-empted by a stale error. Mirrors the
     * iOS HistorySidePanel.showsErrorEmpty.
     */
    val showsErrorEmpty: Boolean get() = error != null && visible.isEmpty() && !loading

    /**
     * True when a re-fetch failed but rows are still loaded — a thin stale banner
     * sits above the (stale) list, rows still shown. Mirrors the iOS
     * HistorySidePanel.showsStaleBanner.
     */
    val showsStaleBanner: Boolean get() = error != null && visible.isNotEmpty()
}

/** Maps a [SessionRowData] to the [SessionRow] shape used by the drawer. */
private fun SessionRowData.toSessionRow(): SessionRow = SessionRow(
    sessionId = id,
    title = title,
    startedAt = 0L,
    lastActiveAt = updatedAtMs,
    messageCount = 0,
    isActive = false,
)

/**
 * Holds the session list for the History drawer. Consumes a [HistoryRepository]
 * for cache-then-refresh loading; mutations route through [sdkProvider] so they
 * share the chat-scoped session. Both are injectable for tests/previews.
 *
 * @param historyRepo  Cache-first session list source.
 * @param sdkProvider  Returns the current SDK for switch/rename/delete/new mutations,
 *                     or null when not yet connected (mutations are no-ops while null).
 */
class HistoryViewModel(
    private val historyRepo: HistoryRepository,
    private val sdkProvider: () -> SentientSdk?,
) : ViewModel() {
    private val log = createLogger("android", "history-viewmodel")

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

    fun switchSession(sessionId: String) {
        log.info("switchSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch {
            runCatching { sdkProvider()?.switchSession(sessionId) }
                .onFailureNonCancellation { warn("switch-failed", it, mapOf("sessionId" to sessionId)) }
            loadSessions()
        }
    }

    fun newChat() {
        log.info("newChat")
        viewModelScope.launch {
            runCatching { sdkProvider()?.newChat() }
                .onFailureNonCancellation { warn("new-failed", it) }
            loadSessions()
        }
    }

    fun renameSession(sessionId: String, title: String) {
        log.info("renameSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch {
            runCatching { sdkProvider()?.renameSession(sessionId, title) }
                .onFailureNonCancellation { warn("rename-failed", it, mapOf("sessionId" to sessionId)) }
            loadSessions()
        }
    }

    fun deleteSession(sessionId: String) {
        log.info("deleteSession", mapOf("sessionId" to sessionId))
        viewModelScope.launch {
            runCatching { sdkProvider()?.deleteSession(sessionId) }
                .onFailureNonCancellation { warn("delete-failed", it, mapOf("sessionId" to sessionId)) }
            loadSessions()
        }
    }

    private suspend fun loadSessions() {
        // cache-then-refresh: load() emits Loading(cached) then Success/Failure.
        historyRepo.load().collect { result ->
            when (result) {
                is SentientResult.Loading -> {
                    val rows = (result.partial ?: emptyList()).map { it.toSessionRow() }
                    _state.value = _state.value.copy(sessions = rows, loading = true, error = null)
                }
                is SentientResult.Success -> {
                    val rows = result.data.map { it.toSessionRow() }
                    log.info("loaded", mapOf("count" to rows.size))
                    _state.value = _state.value.copy(sessions = rows, loading = false, error = null)
                }
                is SentientResult.Failure -> {
                    warn("load-failed", Exception(result.error.userMessage))
                    _state.value = _state.value.copy(
                        loading = false,
                        error = result.error.userMessage,
                    )
                }
            }
        }
    }

    private fun warn(event: String, e: Throwable, extra: Map<String, Any?> = emptyMap()) {
        log.warn(event, extra + mapOf("reason" to (e.message ?: e::class.simpleName)))
    }
}

/**
 * Like [Result.onFailure] but rethrows [CancellationException] so a cancelled
 * viewModelScope (ViewModel cleared / drawer dismissed) propagates instead of
 * being swallowed + logged as a spurious failure.
 */
private inline fun <T> Result<T>.onFailureNonCancellation(action: (Throwable) -> Unit): Result<T> =
    onFailure { if (it is CancellationException) throw it else action(it) }
