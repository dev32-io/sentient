package io.sentient.android.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.sentient.android.BuildConfig
import io.sentient.android.history.HistoryDrawer
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.sdk.SdkFaultHolder
import io.sentient.android.sdk.SdkSessionFactory
import io.sentient.android.settings.SettingsScreen
import io.sentient.android.settings.SettingsViewModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.ErrorKind
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.VoiceMode
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Chat branch of the auth gate. Builds a chat-scoped session + ViewModels, renders
 * [ChatContent] + [HistoryDrawer]. Extracted to keep [AppConfiguredRoot] under the
 * 40-line function limit.
 *
 * Teardown path: [ChatViewModel.onCleared] calls onClose → [chatSession.close].
 * The [chatSession] key drives a fresh VM per session; the old VM is cleared
 * (onCleared → close()) when the key changes on re-entry after logout.
 */
@Composable
internal fun ChatRoot(
    settingsViewModel: SettingsViewModel,
    appPresence: PresenceCoordinator,
    userName: String,
    showSettings: Boolean,
    onShowSettings: () -> Unit,
    onHideSettings: () -> Unit,
    onOpenDrawer: () -> Unit,
    drawerState: androidx.compose.material3.DrawerState,
) {
    val scope = rememberCoroutineScope()

    // One session per chat entry. remember is composition-scoped: a logout→login
    // transition exits + re-enters this composable, producing a fresh session.
    val chatSession = remember { SdkSessionFactory.create() }

    // DEBUG-only: expose the active SDK to DebugFaultReceiver so Maestro flows can
    // arm faults via `adb shell am broadcast -a io.sentient.debug.FAULT --es kind ...`.
    // SdkFaultHolder holds a WeakReference so logout/GC is not prevented.
    if (BuildConfig.DEBUG) {
        androidx.compose.runtime.DisposableEffect(chatSession) {
            SdkFaultHolder.set(chatSession.sdk)
            onDispose { SdkFaultHolder.clear() }
        }
    }

    // ViewModels keyed to chatSession identity so each session entry gets a fresh VM.
    // The old VM is cleared (onCleared → onClose → chatSession.close) when the key
    // changes, providing the single teardown path. No DisposableEffect needed.
    val chatVm = viewModel(key = "chat-${System.identityHashCode(chatSession)}") {
        ChatViewModel(
            chatRepo = chatSession.chatRepo,
            outboxRepo = chatSession.outboxRepo,
            onOpen = { chatSession.open() },
            onClose = { chatSession.close() },
            onForeground = { chatSession.resume() },
            onBackground = { chatSession.pause() },
            presence = appPresence,
        )
    }
    val historyVm = viewModel(key = "history-${System.identityHashCode(chatSession)}") {
        HistoryViewModel(
            historyRepo = chatSession.historyRepo,
            sdkProvider = { chatSession.sdk },
        )
    }

    val chatUi by chatVm.state.collectAsStateWithLifecycle()

    // Derive a plain ConnectionState from the repo's status flow. Prefer Success
    // data, fall back to Loading's partial (may carry partial state during connect),
    // then a blank default (Failure / not yet emitted).
    val connection by chatSession.connectionRepo.status
        .map { result ->
            when (result) {
                is SentientResult.Success -> result.data
                is SentientResult.Loading -> result.partial ?: ConnectionState()
                is SentientResult.Failure -> {
                    val isTerminalAuth =
                        result.error.kind == ErrorKind.AUTH && !result.error.recoverable
                    if (isTerminalAuth) ConnectionState(authExpired = true) else ConnectionState()
                }
            }
        }
        .collectAsStateWithLifecycle(initialValue = ConnectionState())

    // authExpired → logout. Lifecycle-safe one-shot keyed on the flag; fires
    // exactly once on the false→true edge. logout() clears the token + display name,
    // flipping hasToken → false in AppConfiguredRoot → login screen.
    LaunchedEffect(connection.authExpired) {
        if (connection.authExpired) settingsViewModel.logout()
    }

    if (showSettings) {
        SettingsScreen(
            onLogout = {
                settingsViewModel.logout()
                onHideSettings()
            },
            onBack = onHideSettings,
        )
    } else {
        HistoryDrawer(
            viewModel = historyVm,
            drawerState = drawerState,
            nowMs = System.currentTimeMillis(),
            onOpenSettings = onShowSettings,
            userName = userName,
        ) {
            ChatContent(
                uiState = chatUi,
                connection = connection,
                userName = userName,
                onSend = chatVm::send,
                onRetry = chatVm::retry,
                onMicToggle = {
                    if (connection.voiceMode == VoiceMode.ACTIVE) chatSession.sdk.stopMic()
                    else chatSession.sdk.startMic()
                },
                onTtsToggle = {
                    // setTtsEnabled is suspend; fire-and-forget from composition scope.
                    scope.launch { chatSession.sdk.setTtsEnabled(!connection.prefs.ttsEnabled) }
                },
                onInterrupt = { chatSession.sdk.interrupt() },
                onOpenHistory = onOpenDrawer,
                onNewChat = {
                    // newChat is suspend; fire-and-forget newChat on the session.
                    scope.launch { chatSession.sdk.newChat() }
                },
                onReconnect = { chatSession.sdk.forceReconnect() },
            )
        }
    }
}
