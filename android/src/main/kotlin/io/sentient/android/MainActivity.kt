// ---------------------------------------------------------------------------
// MainActivity — the single Activity host. Navigation is a state-based swap:
//
//  1. Backend gate (AppRoot): if no backend is configured (no persisted override
//     and no build-time default URL), force BackendSetupScreen. Once configured,
//     the auth-token-derived swap runs.
//
//  2. Auth gate (AppConfiguredRoot): token present ⇒ chat, otherwise ⇒ login.
//     Token presence (DisplayNameStore.name != null) gates the screen. Gating on
//     status==READY unmounted ChatContent on every WS drop and fell back to login,
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
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.sentient.android.auth.AuthViewModel
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel

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
