// ---------------------------------------------------------------------------
// HistoryViewModel — drives the History drawer's session list + search state.
//
// The SDK does NOT expose a sessions StateFlow or surface SessionsConnector's
// onSessionsChanged through the public SentientSdk API, so per the D-A4 plan
// the drawer re-queries listSessions() on open + after every mutation (switch /
// rename / delete / new). That keeps the list reconnect-safe and never stale:
// each refresh re-reads the gateway truth, including the freshly-recomputed
// isActive flag that drives the active-row highlight.
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
import io.sentient.android.sdk.SdkHolder
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.SessionRow
import io.sentient.mobilesdk.sdk.SentientSdk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Page size for the session list fetch. Mirrors webui's LIST_PAGE_LIMIT (50). */
private const val LIST_PAGE_LIMIT = 50

/**
 * Deadline for the session-list fetch (ms). The dashboard sidecar can be slow or
 * unreachable; without a bound the drawer spinner would spin forever. On timeout
 * the fetch surfaces the SessionsErrorEmpty / stale-banner affordance instead of
 * an indefinite spinner (error-handling rule: timeout every external call).
 * Mirrors the iOS listSessionsTimeoutSeconds (12s).
 */
private const val LIST_SESSIONS_TIMEOUT_MS = 12_000L

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

/**
 * Holds the session list for the History drawer. Default constructor reads the
 * current SDK from [SdkHolder.sdkFlow] at call time so a backend rebuild is
 * reflected without recreating this ViewModel; [sdkProvider] is injectable for
 * tests/previews. Constructing while unconfigured is safe — [SdkHolder.sdkFlow]
 * returns null until a backend is configured.
 *
 * @param sdkProvider Returns the current SDK, or null when not yet configured.
 */
class HistoryViewModel(
    private val sdkProvider: () -> SentientSdk? = { SdkHolder.sdkFlow.value },
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
        val sdk = sdkProvider() ?: return
        _state.value = _state.value.copy(loading = true, error = null)
        // Bound the fetch: an unreachable dashboard sidecar must surface the error
        // affordance, not hang the spinner. withTimeout throws a
        // TimeoutCancellationException on deadline — caught BEFORE the
        // CancellationException rethrow so the timeout becomes a load-failed state
        // (a real scope cancellation still propagates). Parity: iOS SdkStore+Sessions.
        val result = runCatching {
            withTimeout(LIST_SESSIONS_TIMEOUT_MS) { sdk.listSessions(limit = LIST_PAGE_LIMIT, offset = 0) }
        }
        result
            .onSuccess { page ->
                log.info("loaded", mapOf("count" to page.items.size, "total" to page.total))
                _state.value = _state.value.copy(sessions = page.items, loading = false, error = null)
            }
            .onFailure { e ->
                if (e is TimeoutCancellationException) {
                    warn("load-timed-out", e)
                    _state.value = _state.value.copy(loading = false, error = "Couldn't load chats. Tap to retry.")
                    return
                }
                if (e is CancellationException) throw e
                warn("load-failed", e)
                _state.value = _state.value.copy(loading = false, error = e.message ?: "load failed")
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
