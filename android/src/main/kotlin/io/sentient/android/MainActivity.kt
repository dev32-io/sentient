// ---------------------------------------------------------------------------
// MainActivity — the single Activity host. Navigation is a state-based swap:
//
//  1. Backend gate (AppRoot): if no backend is configured (no persisted override
//     and no build-time default URL), force BackendSetupScreen. Once configured,
//     ensureBuilt() is called exactly once and the SDK-status-derived swap runs.
//
//  2. SDK gate (AppConfiguredRoot): status == READY ⇒ chat, otherwise ⇒ login.
//     The gear on the login screen lets the user reopen setup from an already-
//     configured state (e.g. to point at a different server).
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.sentient.android.auth.AuthViewModel
import io.sentient.android.auth.LoginScreen
import io.sentient.android.chat.ChatScreen
import io.sentient.android.history.HistoryDrawer
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.history.rememberHistoryDrawerState
import io.sentient.android.sdk.SdkViewModel
import io.sentient.android.settings.SettingsScreen
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val sdkViewModel: SdkViewModel by viewModels {
        viewModelFactory { initializer { SdkViewModel() } }
    }
    private val authViewModel: AuthViewModel by viewModels {
        viewModelFactory { initializer { AuthViewModel() } }
    }
    private val historyViewModel: HistoryViewModel by viewModels {
        viewModelFactory { initializer { HistoryViewModel() } }
    }
    private val settingsViewModel: SettingsViewModel by viewModels {
        viewModelFactory { initializer { SettingsViewModel() } }
    }
    private val backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel by viewModels {
        viewModelFactory { initializer { io.sentient.android.backend.BackendSetupViewModel() } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Drop high-volume DEBUG tracing in prod (release); keep it in dev.
        LogConfig.minLevel = if (BuildConfig.DEBUG) LogLevel.DEBUG else LogLevel.INFO
        enableEdgeToEdge()
        setContent {
            SentientTheme {
                AppRoot(
                    sdkViewModel = sdkViewModel,
                    authViewModel = authViewModel,
                    historyViewModel = historyViewModel,
                    settingsViewModel = settingsViewModel,
                    backendSetupViewModel = backendSetupViewModel,
                )
            }
        }
    }
}

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun AppRoot(
    sdkViewModel: SdkViewModel,
    authViewModel: AuthViewModel,
    historyViewModel: HistoryViewModel,
    settingsViewModel: SettingsViewModel,
    backendSetupViewModel: io.sentient.android.backend.BackendSetupViewModel,
) {
    val backendConfig by io.sentient.android.backend.BackendConfigHolder.store.config.collectAsStateWithLifecycle()
    // Forced setup: no override AND no build-time default ⇒ unconfigured. Derived
    // from the collected flow so a save (config flips non-null) recomposes the gate.
    var showSetupOverride by rememberSaveable { mutableStateOf(false) }
    val configured = backendConfig != null || io.sentient.android.BuildConfig.GATEWAY_WS_URL.isNotEmpty()
    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        Box(Modifier.fillMaxSize()) {
            if (!configured || showSetupOverride) {
                io.sentient.android.backend.BackendSetupScreen(
                    viewModel = backendSetupViewModel,
                    onSaved = { showSetupOverride = false },
                )
            } else {
                io.sentient.android.sdk.SdkHolder.ensureBuilt()
                AppConfiguredRoot(
                    sdkViewModel, authViewModel, historyViewModel, settingsViewModel,
                    onOpenBackendSetup = { showSetupOverride = true },
                )
            }
        }
    }
}

@Composable
private fun AppConfiguredRoot(
    sdkViewModel: SdkViewModel,
    authViewModel: AuthViewModel,
    historyViewModel: HistoryViewModel,
    settingsViewModel: SettingsViewModel,
    onOpenBackendSetup: () -> Unit,
) {
    val sdkState by sdkViewModel.state.collectAsStateWithLifecycle()
    val drawerState = rememberHistoryDrawerState()
    val scope = rememberCoroutineScope()
    // Settings is an overlay within the READY state, not a separate top-level
    // destination — login-vs-chat stays SDK-derived. rememberSaveable survives
    // config change + process death (mobile-lifecycle rule). The READY guard
    // ensures a logout (status leaves READY) implicitly drops the overlay, so a
    // re-login lands on chat, not a stale settings screen.
    var showSettings by rememberSaveable { mutableStateOf(false) }
    if (sdkState.status == SdkStatus.READY) {
        if (showSettings) {
            SettingsScreen(
                onLogout = {
                    settingsViewModel.logout()
                    showSettings = false
                },
                onBack = { showSettings = false },
            )
        } else {
            HistoryDrawer(
                viewModel = historyViewModel,
                drawerState = drawerState,
                nowMs = System.currentTimeMillis(),
                onOpenSettings = { showSettings = true },
            ) {
                ChatScreen(
                    state = sdkState,
                    onSend = sdkViewModel::sendText,
                    onMicToggle = {
                        if (sdkState.voiceMode == VoiceMode.ACTIVE) sdkViewModel.stopMic()
                        else sdkViewModel.startMic()
                    },
                    onTtsToggle = { sdkViewModel.setTtsEnabled(!sdkState.prefs.ttsEnabled) },
                    onInterrupt = sdkViewModel::interrupt,
                    onOpenHistory = { scope.launch { drawerState.open() } },
                    onOpenSettings = { showSettings = true },
                )
            }
        }
    } else {
        LoginScreen(viewModel = authViewModel, onOpenBackendSetup = onOpenBackendSetup)
    }
}
