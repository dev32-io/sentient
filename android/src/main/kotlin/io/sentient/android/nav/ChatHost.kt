// ---------------------------------------------------------------------------
// ChatHost — the chat destination's composable. Resolves the route-scoped
// ChatViewModel (keyed by sessionId via Koin parametersOf) + the HistoryViewModel,
// renders ChatContent inside the HistoryDrawer (history is the drawer presentation).
//
// History select / new-chat are NAVIGATIONS (onSelectSession / onNewChat) that
// recreate the chat VM — clean per-conversation state. Settings is a navigation.
// authExpired bubbles up to the NavHost (onAuthExpired) which tears the session
// down and routes to login.
//
// Keep-screen-on (S8): FLAG_KEEP_SCREEN_ON lives on the single Activity's window, shared
// across every destination in this single-Activity app — it MUST be cleared here on
// EVERY teardown (nav-away or process death), or it leaks onto whichever screen the user
// navigates to next. See the LaunchedEffect(keepScreenOn) + DisposableEffect(Unit) pair
// below for the full clear-path wiring.
// ---------------------------------------------------------------------------
package io.sentient.android.nav

import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.material3.DrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.chat.ChatContent
import io.sentient.android.chat.ChatViewModel
import io.sentient.android.history.HistoryDrawer
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.history.rememberHistoryDrawerState
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.talk.TalkMode
import org.koin.androidx.compose.koinViewModel
import org.koin.core.parameter.parametersOf
import kotlinx.coroutines.launch

private val keepScreenOnLog = createLogger("android", "chat", "keep-screen-on")

/** Reason tags for the keep-screen-on flag transition log (S8 brief). */
private const val REASON_CONTINUOUS = "continuous"
private const val REASON_SPEAKING = "speaking"
private const val REASON_TEARDOWN = "teardown"

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

    // Keep-screen-on (S8): the VM owns the pure boolean; this screen is the ONLY place
    // that touches the platform flag, so every clear path lives in one auditable spot.
    val talkMode by chatVm.talkMode.collectAsStateWithLifecycle()
    val keepScreenOn by chatVm.keepScreenOn.collectAsStateWithLifecycle()
    val activity by rememberUpdatedState(LocalActivity.current)
    // Carries the last reason a true→false condition was seen so the OFF log line still
    // names what just ended (the OR'd condition is a level signal — both halves read false
    // at the instant it drops, so the "why" has to be remembered, not re-derived).
    var lastOnReason by remember { mutableStateOf(REASON_SPEAKING) }

    // Applies on every ACTUAL flip of keepScreenOn (not on every talkMode/isSpeaking tick
    // that leaves the combined boolean unchanged) — reads the freshest talkMode at the
    // moment of the flip, which is guaranteed current because keepScreenOn is derived FROM
    // it in the same VM combine step.
    LaunchedEffect(keepScreenOn) {
        val window = activity?.window ?: return@LaunchedEffect
        if (keepScreenOn) {
            val reason = if (talkMode == TalkMode.Continuous) REASON_CONTINUOUS else REASON_SPEAKING
            lastOnReason = reason
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            keepScreenOnLog.info("flag", mapOf("on" to true, "reason" to reason))
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            keepScreenOnLog.info("flag", mapOf("on" to false, "reason" to lastOnReason))
        }
    }

    // Teardown clear path: this single Activity's window is shared by every destination
    // (Settings, History, etc.), so leaving THIS composition (nav-away or process death)
    // must force the flag off — otherwise it leaks onto the next screen. Guarded on the
    // flag actually being set so a normal (already-off) teardown stays log-quiet.
    DisposableEffect(Unit) {
        onDispose {
            val window = activity?.window
            if (window != null) {
                val wasOn = window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                if (wasOn) {
                    keepScreenOnLog.info("flag", mapOf("on" to false, "reason" to REASON_TEARDOWN))
                }
            }
        }
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
            talkMode = talkMode,
            userName = userName,
            onSend = chatVm::send,
            onRetry = chatVm::retry,
            onMicPress = chatVm::pressMic,
            onMicRelease = chatVm::releaseMic,
            onMicLock = chatVm::lockMic,
            onMicStopContinuous = chatVm::stopContinuous,
            onTtsToggle = chatVm::toggleTts,
            onInterrupt = chatVm::interrupt,
            onOpenHistory = { scope.launch { drawerState.open() } },
            onNewChat = onNewChat,
            onReconnect = chatVm::reconnect,
            onComposerFocus = chatVm::onComposerFocus,
            onDismissReopenFailed = chatVm::dismissReopenFailedNotice,
            onAllowPermission = chatVm::allowPermission,
            onDenyPermission = chatVm::denyPermission,
        )
    }
}
