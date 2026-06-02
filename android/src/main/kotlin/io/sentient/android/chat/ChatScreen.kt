// ---------------------------------------------------------------------------
// ChatScreen — D-A2 placeholder. D-A3 builds the real chat over the SDK's
// messages/cognition/voice surface. For now this proves login→connect→navigate
// worked: it renders the live SDK status and a `chat-screen` testid the e2e
// driver asserts on. It reads SdkState (the single surface) read-only.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.sentient.mobilesdk.sdk.SdkState

@Composable
fun ChatScreen(
    state: SdkState,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("chat-screen"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "You're in.",
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = "Sentient — ${state.status}",
            modifier = Modifier.testTag("chat-status"),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
