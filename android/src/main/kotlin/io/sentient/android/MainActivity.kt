package io.sentient.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.sentient.android.sdk.SdkViewModel
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.sdk.SdkState

class MainActivity : ComponentActivity() {
    private val sdkViewModel: SdkViewModel by viewModels {
        viewModelFactory { initializer { SdkViewModel() } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SentientTheme {
                val state by sdkViewModel.state.collectAsStateWithLifecycle()
                Surface(Modifier.fillMaxSize()) {
                    BridgeStatus(state)
                }
            }
        }
    }
}

@Composable
private fun BridgeStatus(state: SdkState) {
    Box(
        Modifier.fillMaxSize().safeDrawingPadding(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Sentient — ${state.status}",
            modifier = Modifier.testTag("bridge-status"),
        )
    }
}
