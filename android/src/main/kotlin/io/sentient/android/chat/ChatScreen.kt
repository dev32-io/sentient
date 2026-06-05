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
//  - Composer send always enabled on non-empty draft; queued if not READY, flushed on READY.
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.Fraunces
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
    onNewChat: () -> Unit,
    onReconnect: () -> Unit,
    // TODO: supply the logged-in display name from the backend profile once the
    // Android SdkViewModel/store exposes it (mirrors the iOS caveat — follow-up).
    userName: String = "You",
    modifier: Modifier = Modifier,
) {
    val canInterrupt = state.cognition != CognitionState.IDLE || state.isSpeaking
    val markMode = markModeOf(state)
    val voiceActive = state.voiceMode == VoiceMode.ACTIVE
    // Connection banner derived from the single SDK surface via the pure
    // ConnectionBannerState.derive (STATUS, not connectionLost, discriminates
    // reconnecting vs lost). null ⇒ no banner.
    val banner = ConnectionBannerState.derive(state.status, state.connectionLost)
    // Cycle-error recovery: derive the last user turn to resend (pure), and own
    // the UI-only local-dismiss latch. Reset the dismiss on the false→true error
    // edge so a FRESH error re-shows a previously-dismissed row (parity: iOS
    // CycleErrorRecoveryModifier).
    val lastUserText = CycleErrorRecovery.lastUserText(state.messages)
    var cycleErrorDismissed by remember { mutableStateOf(false) }
    LaunchedEffect(state.lastCycleError) {
        if (state.lastCycleError) cycleErrorDismissed = false
    }
    val showCycleError = state.lastCycleError && !cycleErrorDismissed

    // Queued-send outbox: a send issued before READY is held here and flushed on
    // the READY transition (web-sdk parity). `pending` is hoisted at this level
    // so Phase 13 can read it for "Sending…" affordance without a refactor.
    var pending by remember { mutableStateOf<PendingSend?>(null) }
    val handleSend: (String) -> Unit = { text ->
        if (state.status == SdkStatus.READY) onSend(text)
        else pending = pending?.enqueue(text) ?: PendingSend(text)
    }
    LaunchedEffect(state.status) {
        pending?.flushIfReady(state.status)?.let { queued -> onSend(queued); pending = null }
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .testTag("chat-screen"),
        ) {
            TitleBar(
                markMode = markMode,
                onOpenHistory = onOpenHistory,
                onNewChat = onNewChat,
            )
            MessageList(
                messages = state.messages,
                activeMarkMode = markMode,
                userName = userName,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
            if (voiceActive && state.transcript.isNotEmpty()) {
                TranscriptPreview(text = state.transcript)
            }
            if (showCycleError) {
                CycleErrorBanner(
                    lastUserText = lastUserText,
                    onRetry = { lastUserText?.let(onSend) },
                    onNewChat = onNewChat,
                    onDismiss = { cycleErrorDismissed = true },
                )
            }
            Composer(
                // canSend tints the send glyph: accent = READY (sends now),
                // muted = not READY (tap queues, not drops — see handleSend).
                canSend = state.status == SdkStatus.READY,
                ttsEnabled = state.prefs.ttsEnabled,
                micActive = voiceActive,
                canInterrupt = canInterrupt,
                onSend = handleSend,
                onMicToggle = onMicToggle,
                onTtsToggle = onTtsToggle,
                onInterrupt = onInterrupt,
            )
        }
        if (banner != null) {
            ConnectionBanner(
                state = banner,
                onReconnect = onReconnect,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .safeDrawingPadding()
                    .padding(top = MARK_SIZE),
            )
        }
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
    onNewChat: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onOpenHistory, modifier = Modifier.testTag("history-open")) {
            Text("☰", color = Color(Colors.ink2), fontSize = tokens.type.lg)
        }
        Row(
            modifier = Modifier.weight(1f),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
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
                fontFamily = Fraunces,
            )
        }
        TextButton(onClick = onNewChat, modifier = Modifier.testTag("new-chat")) {
            Text("+", color = Color(Colors.ink2), fontSize = tokens.type.xl)
        }
    }
}
