// ---------------------------------------------------------------------------
// MainActivity — the single Activity host. v1 navigation is a state-based swap
// between the Login screen and the (placeholder) Chat screen, derived from the
// SDK's single state surface: status == READY ⇒ chat, otherwise ⇒ login. This
// matches the codebase's event-driven UX inference — login saves the token +
// calls sdk.connect(); the SDK reaches READY and the UI swaps. No nav library
// for v1 (one decision, two destinations).
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.sentient.android.auth.AuthViewModel
import io.sentient.android.auth.LoginScreen
import io.sentient.android.chat.ChatScreen
import io.sentient.android.sdk.SdkViewModel
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.transport.SdkStatus

class MainActivity : ComponentActivity() {
    private val sdkViewModel: SdkViewModel by viewModels {
        viewModelFactory { initializer { SdkViewModel() } }
    }
    private val authViewModel: AuthViewModel by viewModels {
        viewModelFactory { initializer { AuthViewModel() } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SentientTheme {
                AppRoot(sdkViewModel = sdkViewModel, authViewModel = authViewModel)
            }
        }
    }
}

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun AppRoot(sdkViewModel: SdkViewModel, authViewModel: AuthViewModel) {
    val sdkState by sdkViewModel.state.collectAsStateWithLifecycle()
    Surface(
        Modifier
            .fillMaxSize()
            .semantics { testTagsAsResourceId = true },
    ) {
        Box(Modifier.fillMaxSize()) {
            if (sdkState.status == SdkStatus.READY) {
                ChatScreen(state = sdkState)
            } else {
                LoginScreen(viewModel = authViewModel)
            }
        }
    }
}
