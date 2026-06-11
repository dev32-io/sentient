// ---------------------------------------------------------------------------
// ChatHost — the chat destination's composable. Resolves the route-scoped
// ChatViewModel (keyed by sessionId via Koin parametersOf) + the HistoryViewModel,
// renders ChatContent inside the HistoryDrawer (history is the drawer presentation).
//
// History select / new-chat are NAVIGATIONS (onSelectSession / onNewChat) that
// recreate the chat VM — clean per-conversation state. Settings is a navigation.
// authExpired bubbles up to the NavHost (onAuthExpired) which tears the session
// down and routes to login.
// ---------------------------------------------------------------------------
package io.sentient.android.nav

import androidx.compose.material3.DrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.chat.ChatContent
import io.sentient.android.chat.ChatViewModel
import io.sentient.android.history.HistoryDrawer
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.history.rememberHistoryDrawerState
import org.koin.androidx.compose.koinViewModel
import org.koin.core.parameter.parametersOf
import kotlinx.coroutines.launch

/**
 * Chat destination. [sessionId] is the route param (null = new chat) used to key the
 * ChatViewModel via Koin. The VM is recreated on each navigation, so switching
 * conversation = a fresh VM = clean state.
 *
 * @param onSelectSession Navigate to chat(id) for an existing conversation.
 * @param onNewChat       Navigate to chat(null) for a new conversation.
 * @param onOpenSettings  Navigate to the settings destination.
 * @param onAuthExpired   Terminal auth failure — host tears down + routes to login.
 */
@Composable
internal fun ChatHost(
    sessionId: String?,
    userName: String,
    onSelectSession: (String) -> Unit,
    onNewChat: () -> Unit,
    onOpenSettings: () -> Unit,
    onAuthExpired: () -> Unit,
) {
    // koinViewModel inside a NavHost composable resolves the NavBackStackEntry as the
    // ViewModelStoreOwner — scoped to this route. Navigating to a different sessionId
    // (with popUpTo inclusive) destroys this entry, so the next entry builds a fresh VM.
    val chatVm = koinViewModel<ChatViewModel> { parametersOf(sessionId) }
    val historyVm = koinViewModel<HistoryViewModel>()

    val chatUi by chatVm.state.collectAsStateWithLifecycle()
    val connection by chatVm.connection.collectAsStateWithLifecycle()

    // authExpired → host-driven logout + nav. Fires once on the false→true edge.
    LaunchedEffect(connection.authExpired) {
        if (connection.authExpired) onAuthExpired()
    }

    // Engagement-driven connectivity check on screen entry. Idempotent: READY →
    // liveness probe; not-READY → reconnect + re-establish anchored conversation.
    LaunchedEffect(Unit) {
        chatVm.ensureConnected()
    }

    val drawerState: DrawerState = rememberHistoryDrawerState()
    val scope = rememberCoroutineScope()

    HistoryDrawer(
        viewModel = historyVm,
        drawerState = drawerState,
        nowMs = System.currentTimeMillis(),
        onSelectSession = onSelectSession,
        onNewChat = onNewChat,
        onOpenSettings = onOpenSettings,
        userName = userName,
    ) {
        ChatContent(
            uiState = chatUi,
            connection = connection,
            userName = userName,
            onSend = chatVm::send,
            onRetry = chatVm::retry,
            onMicToggle = chatVm::toggleMic,
            onTtsToggle = chatVm::toggleTts,
            onInterrupt = chatVm::interrupt,
            onOpenHistory = { scope.launch { drawerState.open() } },
            onNewChat = onNewChat,
            onReconnect = chatVm::reconnect,
            onComposerFocus = chatVm::onComposerFocus,
            onDismissReopenFailed = chatVm::dismissReopenFailedNotice,
        )
    }
}
