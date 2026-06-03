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

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.SdkState
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus

private const val TITLE = "Sentient"
private val TRANSCRIPT_RULE_WIDTH = 2.dp
private val MARK_SIZE = 26.dp

@Composable
fun ChatScreen(
    state: SdkState,
    onSend: (String) -> Unit,
    onMicToggle: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val canInterrupt = state.cognition != CognitionState.IDLE || state.isSpeaking
    val markMode = markModeOf(state)
    val voiceActive = state.voiceMode == VoiceMode.ACTIVE
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("chat-screen"),
    ) {
        TitleBar(
            markMode = markMode,
            onOpenHistory = onOpenHistory,
            onOpenSettings = onOpenSettings,
        )
        MessageList(
            messages = state.messages,
            activeMarkMode = markMode,
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
        )
        if (voiceActive && state.transcript.isNotEmpty()) {
            TranscriptPreview(text = state.transcript)
        }
        Composer(
            canSend = state.status == SdkStatus.READY,
            ttsEnabled = state.prefs.ttsEnabled,
            micActive = voiceActive,
            canInterrupt = canInterrupt,
            onSend = onSend,
            onMicToggle = onMicToggle,
            onTtsToggle = onTtsToggle,
            onInterrupt = onInterrupt,
        )
    }
}

/** Live STT preview while voiceMode is ACTIVE — mirrors webui .chat-view__transcript. */
@Composable
private fun TranscriptPreview(text: String) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg)
            .padding(vertical = tokens.space.sm)
            .testTag("voice-transcript"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(TRANSCRIPT_RULE_WIDTH)
                .height(tokens.type.base.value.dp)
                .background(Color(Colors.accent)),
        )
        Text(
            text = text,
            color = Color(Colors.ink3),
            fontStyle = FontStyle.Italic,
            fontSize = tokens.type.base,
            modifier = Modifier.padding(start = tokens.space.sm),
        )
    }
}

@Composable
private fun TitleBar(
    markMode: MarkMode,
    onOpenHistory: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        TextButton(onClick = onOpenHistory, modifier = Modifier.testTag("history-open")) {
            Text("☰", color = Color(Colors.ink2), fontSize = tokens.type.lg)
        }
        SentientMark(
            size = MARK_SIZE,
            mode = markMode,
            modifier = Modifier.testTag("chat-mark").padding(end = tokens.space.xs),
        )
        Text(
            text = TITLE,
            color = Color(Colors.ink),
            fontSize = tokens.type.lg,
            fontWeight = FontWeight.SemiBold,
        )
        Row(modifier = Modifier.weight(1f)) {}
        TextButton(onClick = onOpenSettings, modifier = Modifier.testTag("settings-open")) {
            Text("⚙", color = Color(Colors.ink2), fontSize = tokens.type.lg)
        }
    }
}
