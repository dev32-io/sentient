// ---------------------------------------------------------------------------
// MainActivity — the single Activity host. Navigation is route-based
// (AppNavHost / Navigation-Compose): a chat is a route parameterized by sessionId,
// so switching conversation recreates the chat ViewModel → clean per-conversation
// state. ViewModels are resolved from Koin (started in SentientApp.onCreate), not
// constructed by hand here.
//
// Start gating (backend configured? token present?) lives in AppNavHost's SPLASH
// destination, derived from BackendConfigHolder + DisplayNameHolder — token gates
// the screen, transport status drives the in-chat banner.
//
// testTagsAsResourceId is enabled inside AppNavHost's composition root so Compose
// testTags surface as Android resource-ids for Maestro / uiautomator.
// ---------------------------------------------------------------------------
package io.sentient.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import io.sentient.android.nav.AppNavHost
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // Drop high-volume DEBUG tracing in prod (release); keep it in dev.
        LogConfig.minLevel = if (BuildConfig.DEBUG) LogLevel.DEBUG else LogLevel.INFO
        enableEdgeToEdge()
        setContent {
            SentientTheme {
                AppNavHost()
            }
        }
    }
}
