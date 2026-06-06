// ---------------------------------------------------------------------------
// ChatContentBanners — banner and title-bar composables extracted from
// ChatContent to keep ChatContent.kt under the 300-line clean-code limit.
//
// Composables in this file:
//   ContentTitleBar   — top navigation row (history / mark / new-chat).
//   ContentErrorBanner — inline chat-side error pill (repo/model failures).
//   ContentLoadingPill — connecting/sending spinner pill near the composer.
//   markModeOfConnection — pure mapping from ConnectionState → MarkMode.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.Fraunces
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.sdk.ConnectionState

// Shared layout constants used by banners + title bar.
internal const val CONTENT_TITLE = "Sentient"
internal val MARK_SIZE_CONTENT = 26.dp
private val BANNER_BORDER = 1.dp
internal val CONTENT_SPINNER_SIZE = 14.dp
internal val CONTENT_SPINNER_STROKE = 2.dp

/** Derives MarkMode from ConnectionState fields — analogous to markModeOf(SdkState). */
internal fun markModeOfConnection(connection: ConnectionState): MarkMode {
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
internal fun ContentTitleBar(
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
internal fun ContentErrorBanner(
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
internal fun ContentLoadingPill(affordance: LoadingAffordance) {
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
