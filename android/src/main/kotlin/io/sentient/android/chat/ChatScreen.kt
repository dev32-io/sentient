// ---------------------------------------------------------------------------
// ChatScreen — the real chat surface (D-A3): a title bar, the scrolling
// MessageList, and the Composer dock. Mirrors the webui chat shell (chat-view +
// dock) but drops the breadcrumb top bar for a title-only bar per spec §6.1.
//
// Stateless screen: it reads SdkState (the single SDK surface, collected by the
// host) and dispatches user actions through plain callbacks — MainActivity
// wires those to SdkViewModel. Bindings:
//  - MessageList ← state.messages (user + assistant; the streaming in-flight
//    assistant bubble carries streaming=true → pulse dots / block cursor).
//  - Composer send gated on status == READY (canSend) + non-empty draft.
//  - Composer interrupt shown only when cognition != IDLE || isSpeaking.
//  - TTS toggle reflects state.prefs.ttsEnabled; mic toggle reflects voiceMode.
//
// safeDrawingPadding keeps content clear of system bars; imePadding (in the
// Composer) lifts the dock above the keyboard.
//
// testTag `chat-screen` is retained for the host-level routing assertion.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.SdkState
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus

private const val TITLE = "Sentient"

@Composable
fun ChatScreen(
    state: SdkState,
    onSend: (String) -> Unit,
    onMicToggle: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val canInterrupt = state.cognition != CognitionState.IDLE || state.isSpeaking
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("chat-screen"),
    ) {
        TitleBar()
        MessageList(
            messages = state.messages,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
        Composer(
            canSend = state.status == SdkStatus.READY,
            ttsEnabled = state.prefs.ttsEnabled,
            micActive = state.voiceMode == VoiceMode.ACTIVE,
            canInterrupt = canInterrupt,
            onSend = onSend,
            onMicToggle = onMicToggle,
            onTtsToggle = onTtsToggle,
            onInterrupt = onInterrupt,
        )
    }
}

@Composable
private fun TitleBar() {
    val tokens = LocalTokens.current
    Text(
        text = TITLE,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
        color = Color(Colors.ink),
        fontSize = tokens.type.lg,
        fontWeight = FontWeight.SemiBold,
    )
}
