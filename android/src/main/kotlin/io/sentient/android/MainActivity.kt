// ---------------------------------------------------------------------------
// MainActivity — the single Activity host. Navigation is a state-based swap:
//
//  1. Backend gate (AppRoot): if no backend is configured (no persisted override
//     and no build-time default URL), force BackendSetupScreen. Once configured,
//     the auth-token-derived swap runs.
//
//  2. Auth gate (AppConfiguredRoot): token present ⇒ chat, otherwise ⇒ login.
//     Token presence (DisplayNameStore.name != null) gates the screen. Gating on
//     status==READY unmounted ChatScreen on every WS drop and fell back to login,
//     hiding the in-chat connection-lost banner. Token is set on login and cleared
//     on logout — so a WS drop keeps the user on chat WITH the banner. Mirrors
//     web-sdk: AUTH gates the screen, status drives the banner.
//     The gear on the login screen lets the user reopen setup from an
//     already-configured state (e.g. to point at a different server).
//
// testTagsAsResourceId is enabled at the composition root so Compose testTags
// surface as Android resource-ids — that's what uiautomator / Maestro / the
// `android` CLI read to target the login + chat elements in the e2e drive.
// ---------------------------------------------------------------------------
package io.sentient.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.sentient.android.auth.AuthViewModel
import io.sentient.android.auth.LoginScreen
import io.sentient.android.chat.AppSplashOverlay
import io.sentient.android.chat.ChatContent
import io.sentient.android.chat.ChatViewModel
import io.sentient.android.chat.SPLASH_MIN_MS
import io.sentient.android.chat.splashVisible
import io.sentient.android.history.HistoryDrawer
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.history.rememberHistoryDrawerState
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.sdk.SdkSessionFactory
import io.sentient.android.settings.SettingsScreen
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.theme.SentientTheme
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.VoiceMode
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val authViewModel: AuthViewModel by viewModels {
        viewModelFactory { initializer { AuthViewModel() } }
    }
    private val settingsViewModel: SettingsViewModel by viewModels {
        viewModelFactory { initializer { SettingsViewModel() } }
    }
    private val backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel by viewModels {
        viewModelFactory { initializer { io.sentient.android.backend.BackendSetupViewModel() } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // Drop high-volume DEBUG tracing in prod (release); keep it in dev.
        LogConfig.minLevel = if (BuildConfig.DEBUG) LogLevel.DEBUG else LogLevel.INFO
        enableEdgeToEdge()
        setContent {
            SentientTheme {
                AppRoot(
                    authViewModel = authViewModel,
                    settingsViewModel = settingsViewModel,
                    backendSetupViewModel = backendSetupViewModel,
                )
            }
        }
    }
}

private val splashLog = createLogger("android", "splash")

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun AppRoot(
    authViewModel: AuthViewModel,
    settingsViewModel: SettingsViewModel,
    backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel,
) {
    val backendConfig by io.sentient.android.backend.BackendConfigHolder.store.config.collectAsStateWithLifecycle()
    // Forced setup: no override AND no build-time default ⇒ unconfigured. Derived
    // from the collected flow so a save (config flips non-null) recomposes the gate.
    var showSetupOverride by rememberSaveable { mutableStateOf(false) }
    val configured = backendConfig != null || io.sentient.android.BuildConfig.GATEWAY_WS_URL.isNotEmpty()

    // App-scoped presence coordinator: registered once, forwarded to whatever
    // ChatSession is currently bound via ChatViewModel.presence.
    val appPresence = remember { PresenceCoordinator() }
    LaunchedEffect(Unit) { appPresence.start() }

    // Splash clock: reset on every backend config change.
    // shownAtMs starts 0 so (0-0)<2000 → visible=true on the very first frame.
    var shownAtMs by remember { mutableLongStateOf(0L) }
    var nowMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(configured) {
        shownAtMs = System.currentTimeMillis()
        splashLog.info("splash.show", mapOf("trigger" to "rebuild"))
    }
    LaunchedEffect(shownAtMs) {
        while (System.currentTimeMillis() - shownAtMs < SPLASH_MIN_MS) {
            withFrameMillis { nowMs = System.currentTimeMillis() }
        }
        nowMs = System.currentTimeMillis()
    }

    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        Box(Modifier.fillMaxSize()) {
            if (!configured || showSetupOverride) {
                io.sentient.android.backend.BackendSetupScreen(
                    viewModel = backendSetupViewModel,
                    onSaved = { showSetupOverride = false },
                )
            } else {
                AppConfiguredRoot(
                    authViewModel = authViewModel,
                    settingsViewModel = settingsViewModel,
                    appPresence = appPresence,
                    onOpenBackendSetup = { showSetupOverride = true },
                )
            }
            // Overlay sits ABOVE all gate content; fades out once the min-time floor
            // elapses. ready=true: the floor alone gates the fade — the gate content
            // (setup screen OR chat/login) is always renderable, so gating on
            // `configured` would deadlock an unconfigured first launch (splash never hides).
            AppSplashOverlay(visible = splashVisible(shownAtMs, nowMs, ready = true))
        }
    }
}

/** Neutral display-name fallback shown before login persists a real name. */
private const val DEFAULT_DISPLAY_NAME = "You"

@Composable
private fun AppConfiguredRoot(
    authViewModel: AuthViewModel,
    settingsViewModel: SettingsViewModel,
    appPresence: PresenceCoordinator,
    onOpenBackendSetup: () -> Unit,
) {
    // Nav gate: token present (displayName != null) ⇒ chat, otherwise ⇒ login.
    // displayName is saved at login and cleared at logout — it acts as a reactive
    // proxy for token presence. A WS drop does NOT clear it, so the user stays on
    // chat with the connection-lost banner. Mirrors web-sdk: AUTH gates the screen.
    val displayName by io.sentient.android.sdk.DisplayNameHolder.store.name
        .collectAsStateWithLifecycle()
    val userName = displayName ?: DEFAULT_DISPLAY_NAME
    val hasToken = displayName != null

    val drawerState = rememberHistoryDrawerState()
    val scope = rememberCoroutineScope()
    // Settings is an overlay within the in-session state, not a separate top-level
    // destination. rememberSaveable survives config change + process death. The
    // hasToken guard ensures a logout implicitly drops the overlay.
    var showSettings by rememberSaveable { mutableStateOf(false) }

    if (hasToken) {
        ChatRoot(
            settingsViewModel = settingsViewModel,
            appPresence = appPresence,
            userName = userName,
            showSettings = showSettings,
            onShowSettings = { showSettings = true },
            onHideSettings = { showSettings = false },
            onOpenDrawer = { scope.launch { drawerState.open() } },
            drawerState = drawerState,
        )
    } else {
        LoginScreen(viewModel = authViewModel, onOpenBackendSetup = onOpenBackendSetup)
    }
}

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
private fun ChatRoot(
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

    // ViewModels keyed to chatSession identity so each session entry gets a fresh VM.
    // The old VM is cleared (onCleared → onClose → chatSession.close) when the key
    // changes, providing the single teardown path. No DisposableEffect needed.
    val chatVm = viewModel(key = "chat-${System.identityHashCode(chatSession)}") {
        ChatViewModel(
            repo = chatSession.chatRepo,
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
                is SentientResult.Failure -> ConnectionState()
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
                    // newChat is suspend; fire-and-forget, mirrors SdkViewModel.newChat.
                    scope.launch { chatSession.sdk.newChat() }
                },
                onReconnect = { chatSession.sdk.forceReconnect() },
            )
        }
    }
}
