// ---------------------------------------------------------------------------
// HistoryDrawer — the Android History drawer (D-A4). A Material3
// ModalNavigationDrawer (native; replaces the webui 360px CSS drawer) wrapping
// the chat content. Drawer content mirrors the webui sessions drawer:
//   - account header (avatar, name, household, gear → settings)
//   - a search pill (history-search) that filters the list client-side
//   - "Past chats" title in Fraunces
//   - the session list from sdk.listSessions (title + relative time + message
//     count; active session highlighted via SessionRow.isActive), grouped by
//     date bucket (Today / Yesterday / Last 7 days / Older)
//   - tap a row → sdk.switchSession + close; long-press → rename/delete menu
//   - a floating "+" FAB (history-new-chat) → sdk.newChat + close
//
// Reconnect-safe refresh: the list re-queries on every drawer-open AND after
// every mutation (HistoryViewModel re-calls listSessions in each op). The SDK
// does not surface SessionsConnector.onSessionsChanged through SentientSdk, so
// the open + post-mutation re-query is the refresh path (D-A4 plan fallback).
//
// testTags: history-search, history-row-<sessionId>, history-new-chat,
//           settings-open (in HistoryAccountHeader). The history-open trigger
//           lives in the ChatScreen top bar (see ChatScreen.kt).
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.theme.Fraunces
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import kotlinx.coroutines.launch

private const val EMPTY_DEFAULT = "No past chats yet."
private val HISTORY_SPINNER_SIZE = 24.dp
private val HISTORY_SPINNER_STROKE = 2.dp

private data class PendingTarget(val id: String, val title: String)

/**
 * Wraps [content] in a ModalNavigationDrawer whose drawer is the session
 * history. [drawerState] + [nowMs] are hoisted by the host (MainActivity) so the
 * chat top bar's history-open trigger can open the drawer and the date labels
 * read one stable clock per composition pass.
 *
 * [onOpenSettings] is called when the user taps the gear in the account header.
 * [userName] is the logged-in display name supplied by the host from
 * DisplayNameStore (set at login, cleared on logout), defaulting to "You" only as
 * a fallback. [household] stays "" until the gateway exposes per-profile metadata
 * through the SDK — HistoryAccountHeader omits the subtitle line while it is empty.
 */
@Composable
fun HistoryDrawer(
    viewModel: HistoryViewModel,
    drawerState: DrawerState,
    nowMs: Long,
    onOpenSettings: () -> Unit = {},
    userName: String = "You",
    household: String = "",
    content: @Composable () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    // Reconnect-safe: re-query on every open so the list never goes stale.
    LaunchedEffect(drawerState.currentValue) {
        if (drawerState.currentValue == DrawerValue.Open) viewModel.refresh()
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet {
                HistoryContent(
                    state = state,
                    nowMs = nowMs,
                    userName = userName,
                    household = household,
                    onOpenSettings = onOpenSettings,
                    onQuery = viewModel::setQuery,
                    onRetry = viewModel::refresh,
                    onSwitch = { id ->
                        viewModel.switchSession(id)
                        scope.launch { drawerState.close() }
                    },
                    onRename = viewModel::renameSession,
                    onDelete = viewModel::deleteSession,
                    onNewChat = {
                        viewModel.newChat()
                        scope.launch { drawerState.close() }
                    },
                )
            }
        },
        content = content,
    )
}

@Composable
private fun HistoryContent(
    state: HistoryUiState,
    nowMs: Long,
    userName: String,
    household: String,
    onOpenSettings: () -> Unit,
    onQuery: (String) -> Unit,
    onRetry: () -> Unit,
    onSwitch: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onNewChat: () -> Unit,
) {
    val tokens = LocalTokens.current
    var renaming by remember { mutableStateOf<PendingTarget?>(null) }
    var deleting by remember { mutableStateOf<PendingTarget?>(null) }

    Box(modifier = Modifier.fillMaxSize().safeDrawingPadding()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            HistoryAccountHeader(
                name = userName,
                household = household,
                onSettings = onOpenSettings,
            )
            SearchPill(
                query = state.query,
                onQuery = onQuery,
            )
            Text(
                text = "Past chats",
                modifier = Modifier.padding(vertical = tokens.space.sm),
                color = Color(Colors.ink),
                fontSize = tokens.type.lg,
                fontWeight = FontWeight.SemiBold,
                fontFamily = Fraunces,
            )
            // Stale-failure banner sits above the still-rendered (stale) rows; a
            // total failure with no rows is handled inside SessionListBody, which
            // swaps the empty text for the SessionsErrorEmpty retry affordance.
            if (state.showsStaleBanner) {
                SessionsStaleBanner(onRetry = onRetry)
            }
            Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                SessionListBody(
                    state = state,
                    nowMs = nowMs,
                    onRetry = onRetry,
                    onSwitch = onSwitch,
                    onAskRename = { id, title -> renaming = PendingTarget(id, title) },
                    onAskDelete = { id, title -> deleting = PendingTarget(id, title) },
                )
            }
        }
        FloatingActionButton(
            onClick = onNewChat,
            containerColor = Color(Colors.accent),
            contentColor = HistoryOnAccent,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(tokens.space.lg)
                .testTag("history-new-chat"),
        ) {
            Text("+", fontSize = tokens.type.xl)
        }
    }

    renaming?.let { target ->
        RenameDialog(
            initialTitle = target.title,
            onConfirm = { onRename(target.id, it) },
            onDismiss = { renaming = null },
        )
    }
    deleting?.let { target ->
        ConfirmDeleteDialog(
            title = target.title,
            onConfirm = { onDelete(target.id) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun SessionListBody(
    state: HistoryUiState,
    nowMs: Long,
    onRetry: () -> Unit,
    onSwitch: (String) -> Unit,
    onAskRename: (String, String) -> Unit,
    onAskDelete: (String, String) -> Unit,
) {
    val tokens = LocalTokens.current
    val rows = state.visible
    if (rows.isEmpty()) {
        // Total load failure with no rows → the retry affordance, not dead text.
        if (state.showsErrorEmpty) {
            SessionsErrorEmpty(onRetry = onRetry)
            return
        }
        // First-load spinner: visible spinner instead of static text while fetching.
        if (state.loading) {
            CircularProgressIndicator(
                modifier = Modifier
                    .size(HISTORY_SPINNER_SIZE)
                    .testTag("history-loading"),
                color = Color(Colors.ink3),
                strokeWidth = HISTORY_SPINNER_STROKE,
            )
            return
        }
        val msg = if (state.isSearching) {
            "No matches for \"${state.query.trim()}\""
        } else {
            EMPTY_DEFAULT
        }
        Text(text = msg, color = Color(Colors.ink3), fontSize = tokens.type.sm)
        return
    }
    // Group by date bucket (Today / Yesterday / Last 7 days / Older), mirroring
    // the webui session-list.tsx. Rows arrive lastActiveAt-descending from the
    // gateway, so a single forward pass keeps buckets ordered.
    val groups = groupByDate(rows, nowMs)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        for (group in groups) {
            item(key = "group-${group.label}") {
                Text(
                    text = group.label,
                    modifier = Modifier.padding(top = tokens.space.sm, bottom = tokens.space.xs),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.xs,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            items(group.rows, key = { it.sessionId }) { row ->
                HistoryRow(
                    row = row,
                    nowMs = nowMs,
                    onSwitch = { onSwitch(row.sessionId) },
                    onAskRename = { onAskRename(row.sessionId, row.title) },
                    onAskDelete = { onAskDelete(row.sessionId, row.title) },
                )
            }
        }
    }
}

/** Search field styled as a pill: rounded corners, bgElev fill, lineSoft border. */
@Composable
private fun SearchPill(query: String, onQuery: (String) -> Unit) {
    val tokens = LocalTokens.current
    OutlinedTextField(
        value = query,
        onValueChange = onQuery,
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(Colors.bgElev), RoundedCornerShape(tokens.radii.pill))
            .testTag("history-search"),
        singleLine = true,
        shape = RoundedCornerShape(tokens.radii.pill),
        placeholder = { Text("Search past chats", color = Color(Colors.ink3)) },
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Color(Colors.lineSoft),
            unfocusedBorderColor = Color(Colors.lineSoft),
            focusedTextColor = Color(Colors.ink),
            unfocusedTextColor = Color(Colors.ink),
            cursorColor = Color(Colors.accent),
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent,
        ),
    )
}

/** Convenience: a remembered drawer state, closed by default. */
@Composable
fun rememberHistoryDrawerState(): DrawerState = rememberDrawerState(DrawerValue.Closed)
