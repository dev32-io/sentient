// ---------------------------------------------------------------------------
// ChatContent — the NEW chat surface driven by ChatUiState + ConnectionState.
//
// Drop-in replacement for ChatScreen (Task 3.4, rendering half). Consumes the
// KMP-layer data model (committed history + optimistic pending outbox + live
// streaming bubble + task pills) and the separate ConnectionState, so the VM
// is the only place that holds references to SDK or repo. The old ChatScreen
// (SdkState path) is left UNTOUCHED until MainActivity is rewired (next task).
//
// Row ordering in the MessageList:
//   1. committed messages (as ChatRow.Msg, with day-dividers from chatRows())
//   2. pending outbox entries (as ChatRow.Pending, QUEUED→SENT→FAILED chips)
//   3. live streaming assistant bubble (as ChatRow.Msg with live.copy(tools=tasks))
//      — this is appended only when ChatModel.live != null.
//
// Banners (top-of-stack, highest priority first):
//   1. chat-side ErrorBanner from ChatUiState (e.g. ChatRepository failure)
//   2. connection banner derived from ConnectionState (lost / reconnecting)
//
// Composer: reuses the existing Composer composable verbatim. Voice/TTS/canSend
// state is derived from ConnectionState (voiceMode / isSpeaking / prefs /
// status). The queued-send outbox lives HERE (same PendingSend mini-outbox
// pattern as ChatScreen) until the ChatViewModel is wired to a real Outbox.
//
// testTags added in this file:
//   - composer-input   → wired through Composer via "chat-input" (existing tag)
//   - composer-send    → wired through Composer via "chat-send" (existing tag)
//   - mic-toggle       → wired through Composer via "chat-mic" (existing tag)
//   - banner-connection → the connection-state banner pill (lost / reconnecting)
//   - banner-chat       → the chat-side error banner
//   - content-screen    → the root Column (Maestro scoping)
//
// Note: Composer already uses testTag("chat-input"), ("chat-send"), ("chat-mic").
// This file maps the ChatContent callback names to those callsites without
// renaming tags (existing Maestro flows keep working).
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus

// Layout constants — mirrors ChatScreen dimensions for visual parity.
private const val CONTENT_TITLE = "Sentient"
private val MARK_SIZE_CONTENT = 26.dp
private val TRANSCRIPT_RULE_WIDTH_CONTENT = 2.dp
private val CONTENT_SPINNER_SIZE = 14.dp
private val CONTENT_SPINNER_STROKE = 2.dp
private val BANNER_BORDER = 1.dp

/**
 * Pure composable: state in, callbacks out. No SDK / repo references.
 *
 * @param uiState       Chat model (committed + pending + live + tasks) + banner.
 * @param connection    Transport + voice state from the KMP SDK.
 * @param onSend        User submitted a text message.
 * @param onMicToggle   Mic button tapped.
 * @param onTtsToggle   TTS toggle tapped.
 * @param onInterrupt   Stop button tapped (cycle/audio abort).
 * @param onOpenHistory History drawer opened.
 * @param onNewChat     New-chat button tapped.
 * @param onReconnect   Retry button on the connection-lost banner tapped.
 * @param userName      Logged-in user's display name for bubble avatars.
 */
@Composable
fun ChatContent(
    uiState: ChatUiState,
    connection: ConnectionState,
    onSend: (String) -> Unit,
    onMicToggle: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
    onOpenHistory: () -> Unit,
    onNewChat: () -> Unit,
    onReconnect: () -> Unit,
    userName: String = "You",
    modifier: Modifier = Modifier,
) {
    val markMode = markModeOfConnection(connection)
    val voiceActive = connection.voiceMode == VoiceMode.ACTIVE
    val canInterrupt = connection.isSpeaking ||
        connection.audioState == AudioState.PROCESSING ||
        connection.audioState == AudioState.ASSISTANT_SPEAKING ||
        connection.audioState == AudioState.INTERRUPTING

    // Build the display message list:
    //   committed (with day-dividers) ++ pending (status chips) ++ live bubble.
    val committed = uiState.model.committed
    val pending = uiState.model.pending
    val live = uiState.model.live?.copy(tools = uiState.model.tasks)

    // displayMessages = committed + live. Pending rows are handled separately
    // as ChatRow.Pending via the MessageList `pending` parameter.
    val displayMessages = if (live != null) committed + live else committed

    // Derive connection banner state from ConnectionState fields.
    val connectionBanner = ConnectionBannerState.derive(connection.status, connection.connectionLost)

    // Queued-send outbox: same pattern as ChatScreen — hold sends before READY
    // and flush on the READY edge. (The VM-layer Outbox reconciles via pendingId
    // once wired in Task 3.5/3.7; this is the UI-side buffer for the text path.)
    var pendingSend by remember { mutableStateOf<PendingSend?>(null) }
    val handleSend: (String) -> Unit = { text ->
        if (connection.status == SdkStatus.READY) onSend(text)
        else pendingSend = pendingSend?.enqueue(text) ?: PendingSend(listOf(text))
    }
    LaunchedEffect(connection.status) {
        pendingSend?.flushIfReady(connection.status)?.let { queued ->
            queued.forEach { onSend(it) }
            pendingSend = null
        }
    }

    val affordance = loadingAffordance(
        status = connection.status,
        connectionLost = connection.connectionLost,
        hasPending = pendingSend != null,
    )

    Box(modifier = modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .testTag("content-screen"),
        ) {
            ContentTitleBar(
                markMode = markMode,
                onOpenHistory = onOpenHistory,
                onNewChat = onNewChat,
            )
            MessageList(
                messages = displayMessages,
                activeMarkMode = markMode,
                userName = userName,
                pending = pending,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
            if (voiceActive && connection.voiceMode == VoiceMode.ACTIVE) {
                // STT transcript preview placeholder — wired in when transcript
                // is available via ConnectionState (Phase 4 audio pipeline).
                // Left as a no-op here; the TranscriptPreview in ChatScreen
                // reads state.transcript which is not in ConnectionState yet.
            }
            // Chat-side error banner (repository / model failure).
            if (uiState.banner != null) {
                ContentErrorBanner(
                    banner = uiState.banner,
                    onRetry = if (uiState.banner.canRetry) onReconnect else null,
                )
            }
            if (affordance != LoadingAffordance.NONE) {
                ContentLoadingPill(affordance = affordance)
            }
            Composer(
                canSend = connection.status == SdkStatus.READY,
                ttsEnabled = connection.prefs.ttsEnabled,
                micActive = voiceActive,
                canInterrupt = canInterrupt,
                onSend = handleSend,
                onMicToggle = onMicToggle,
                onTtsToggle = onTtsToggle,
                onInterrupt = onInterrupt,
            )
        }

        // Connection banner floats over the top — same overlay pattern as ChatScreen.
        if (connectionBanner != null) {
            ConnectionBanner(
                state = connectionBanner,
                onReconnect = onReconnect,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .safeDrawingPadding()
                    .padding(top = MARK_SIZE_CONTENT)
                    .testTag("banner-connection"),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Internal composables — mirrors ChatScreen's private helpers
// ---------------------------------------------------------------------------

/** Derives MarkMode from ConnectionState fields — analogous to markModeOf(SdkState). */
private fun markModeOfConnection(connection: ConnectionState): MarkMode {
    val speaking = connection.isSpeaking ||
        connection.audioState == AudioState.ASSISTANT_SPEAKING
    if (speaking) return MarkMode.SPEAKING
    val thinking = connection.audioState == AudioState.PROCESSING
    if (thinking) return MarkMode.THINKING
    val listening = connection.audioState == AudioState.LISTENING ||
        connection.audioState == AudioState.USER_SPEAKING
    if (listening) return MarkMode.LISTENING
    return MarkMode.IDLE
}

@Composable
private fun ContentTitleBar(
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
                size = MARK_SIZE_CONTENT,
                mode = markMode,
                modifier = Modifier
                    .testTag("chat-mark")
                    .padding(end = tokens.space.xs),
            )
            Text(
                text = CONTENT_TITLE,
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

/**
 * Chat-side error banner for repository / model failures (ErrorBanner from
 * ChatUiState). Distinct from ConnectionBanner (which handles transport loss).
 * testTag: `banner-chat`.
 */
@Composable
private fun ContentErrorBanner(
    banner: ErrorBanner,
    onRetry: (() -> Unit)?,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.xs)
            .background(Color(Colors.stop).copy(alpha = 0.08f), RoundedCornerShape(tokens.radii.pill))
            .border(BANNER_BORDER, Color(Colors.stop).copy(alpha = 0.25f), RoundedCornerShape(tokens.radii.pill))
            .padding(horizontal = tokens.space.md, vertical = tokens.space.xs)
            .testTag("banner-chat"),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = banner.text,
            color = Color(Colors.stop),
            fontSize = tokens.type.sm,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1f),
        )
        if (onRetry != null) {
            TextButton(onClick = onRetry) {
                Text(
                    text = "Retry",
                    color = Color(Colors.accent),
                    fontSize = tokens.type.sm,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

/**
 * Inline loading pill (connecting / sending) — mirrors ChatScreen's LoadingPill.
 * testTag: `loading-connecting` or `loading-sending`.
 */
@Composable
private fun ContentLoadingPill(affordance: LoadingAffordance) {
    val tokens = LocalTokens.current
    val label = when (affordance) {
        LoadingAffordance.CONNECTING -> "Connecting…"
        LoadingAffordance.SENDING -> "Sending…"
        LoadingAffordance.NONE -> return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.xs)
            .testTag("loading-${affordance.name.lowercase()}"),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(CONTENT_SPINNER_SIZE),
            color = Color(Colors.ink3),
            strokeWidth = CONTENT_SPINNER_STROKE,
        )
        Text(text = label, color = Color(Colors.ink2), fontSize = tokens.type.sm)
    }
}
