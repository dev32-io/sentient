// ---------------------------------------------------------------------------
// HistoryDrawer — the Android History drawer (D-A4). A Material3
// ModalNavigationDrawer (native; replaces the webui 360px CSS drawer) wrapping
// the chat content. Drawer content mirrors the webui sessions drawer:
//   - a search field (history-search) that filters the list client-side
//   - the session list from sdk.listSessions (title + relative time + message
//     count; active session highlighted via SessionRow.isActive), grouped by
//     date bucket (Today / Yesterday / Last 7 days / Older)
//   - tap a row → sdk.switchSession + close; long-press → rename/delete menu
//   - a New Chat button (history-new-chat) → sdk.newChat + close
//
// Reconnect-safe refresh: the list re-queries on every drawer-open AND after
// every mutation (HistoryViewModel re-calls listSessions in each op). The SDK
// does not surface SessionsConnector.onSessionsChanged through SentientSdk, so
// the open + post-mutation re-query is the refresh path (D-A4 plan fallback).
//
// testTags: history-search, history-row-<sessionId>, history-new-chat. The
// history-open trigger lives in the ChatScreen top bar (see ChatScreen.kt).
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import kotlinx.coroutines.launch

private const val EMPTY_DEFAULT = "No past chats yet."
private const val EMPTY_LOAD_FAIL = "Couldn't load sessions — try again."

private data class PendingTarget(val id: String, val title: String)

/**
 * Wraps [content] in a ModalNavigationDrawer whose drawer is the session
 * history. [drawerState] + [nowMs] are hoisted by the host (MainActivity) so the
 * chat top bar's history-open trigger can open the drawer and the date labels
 * read one stable clock per composition pass.
 */
@Composable
fun HistoryDrawer(
    viewModel: HistoryViewModel,
    drawerState: DrawerState,
    nowMs: Long,
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
                    onQuery = viewModel::setQuery,
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
    onQuery: (String) -> Unit,
    onSwitch: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onNewChat: () -> Unit,
) {
    val tokens = LocalTokens.current
    var renaming by remember { mutableStateOf<PendingTarget?>(null) }
    var deleting by remember { mutableStateOf<PendingTarget?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(horizontal = tokens.space.md),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Text(
            text = "Past chats",
            modifier = Modifier.padding(vertical = tokens.space.md),
            color = Color(Colors.ink),
            fontSize = tokens.type.lg,
            fontWeight = FontWeight.SemiBold,
        )
        OutlinedTextField(
            value = state.query,
            onValueChange = onQuery,
            modifier = Modifier.fillMaxWidth().testTag("history-search"),
            singleLine = true,
            placeholder = { Text("Search past chats", color = Color(Colors.ink3)) },
        )
        Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            SessionListBody(
                state = state,
                nowMs = nowMs,
                onSwitch = onSwitch,
                onAskRename = { id, title -> renaming = PendingTarget(id, title) },
                onAskDelete = { id, title -> deleting = PendingTarget(id, title) },
            )
        }
        NewChatButton(onClick = onNewChat)
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
    onSwitch: (String) -> Unit,
    onAskRename: (String, String) -> Unit,
    onAskDelete: (String, String) -> Unit,
) {
    val tokens = LocalTokens.current
    val rows = state.visible
    if (rows.isEmpty()) {
        val msg = when {
            state.loading -> "Loading…"
            state.error != null -> EMPTY_LOAD_FAIL
            state.isSearching -> "No matches for \"${state.query.trim()}\""
            else -> EMPTY_DEFAULT
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

private data class DateGroup(val label: String, val rows: List<io.sentient.mobilesdk.protocol.SessionRow>)

private fun groupByDate(
    rows: List<io.sentient.mobilesdk.protocol.SessionRow>,
    nowMs: Long,
): List<DateGroup> {
    val out = mutableListOf<DateGroup>()
    var current: MutableList<io.sentient.mobilesdk.protocol.SessionRow>? = null
    var label = ""
    for (row in rows) {
        val l = dateGroupLabel(nowMs, row.lastActiveAt)
        if (current == null || l != label) {
            current = mutableListOf(row)
            label = l
            out.add(DateGroup(l, current))
        } else {
            current.add(row)
        }
    }
    return out
}

@Composable
private fun NewChatButton(onClick: () -> Unit) {
    val tokens = LocalTokens.current
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = tokens.space.sm)
            .testTag("history-new-chat"),
        colors = ButtonDefaults.buttonColors(
            containerColor = Color(Colors.accent),
            contentColor = Color(Colors.bg),
        ),
    ) {
        Text("New Chat")
    }
}

/** Convenience: a remembered drawer state, closed by default. */
@Composable
fun rememberHistoryDrawerState(): DrawerState = rememberDrawerState(DrawerValue.Closed)
