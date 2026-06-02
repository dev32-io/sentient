// ---------------------------------------------------------------------------
// MessageBubble — one rendered chat message, mirroring the webui MessageBubble
// (gateway/webui/src/components/chat/message-bubble.tsx + components.css).
//
// Layout per role:
//  - assistant: avatar (SentientMark) left, bubble flush-top-LEFT (6dp), other
//    corners Radii.lg (18dp); paper background.
//  - user: avatar (initial circle) right, bubble flush-top-RIGHT (6dp), other
//    corners Radii.lg; sage-mixed-into-paper background (webui
//    color-mix(sage 16%, paper)).
// Both: 1dp lineSoft border, padMsg (18dp) text padding, ink text, capped at
// msgMax width. A streaming assistant message with no text yet shows the
// three-dot pulse (mirrors BubbleText PlaceholderPulse); once text arrives it
// renders the text plus a trailing block cursor while still streaming.
//
// Markdown is a v1 FOLLOW-UP — D-A3 renders PLAIN TEXT only.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage

private val FLUSH_CORNER = 6.dp
private val AVATAR_SIZE = 28.dp

/** webui user bubble: color-mix(in oklab, sage 16%, paper). Approximated via lerp. */
private val USER_BUBBLE_BG: Color = lerp(Color(Colors.paper), Color(Colors.sage), 0.16f)

/** Tag prefix the e2e driver asserts on: `message-bubble-<index>`. */
private const val BUBBLE_TAG_PREFIX = "message-bubble-"

@Composable
fun MessageBubble(
    message: ChatMessage,
    index: Int,
    modifier: Modifier = Modifier,
) {
    val isUser = message.role == "user"
    val arrangement = if (isUser) Arrangement.End else Arrangement.Start
    Row(
        modifier = modifier.testTag("$BUBBLE_TAG_PREFIX$index"),
        horizontalArrangement = arrangement,
        verticalAlignment = Alignment.Top,
    ) {
        if (isUser) {
            BubbleBody(message = message, isUser = true)
            BubbleAvatar(message = message)
        } else {
            BubbleAvatar(message = message)
            BubbleBody(message = message, isUser = false)
        }
    }
}

/** Assistant → SentientMark; user → tinted initial circle. */
@Composable
private fun BubbleAvatar(message: ChatMessage) {
    val tokens = LocalTokens.current
    val gap = tokens.space.md
    if (message.role == "user") {
        Box(
            modifier = Modifier
                .padding(start = gap)
                .size(AVATAR_SIZE)
                .clip(CircleShape)
                .background(Color(Colors.sageSoft)),
        )
    } else {
        SentientMark(modifier = Modifier.padding(end = gap), size = AVATAR_SIZE)
    }
}

@Composable
private fun BubbleBody(message: ChatMessage, isUser: Boolean) {
    val tokens = LocalTokens.current
    val r = tokens.radii.lg
    val shape = if (isUser) {
        RoundedCornerShape(topStart = r, topEnd = FLUSH_CORNER, bottomEnd = r, bottomStart = r)
    } else {
        RoundedCornerShape(topStart = FLUSH_CORNER, topEnd = r, bottomEnd = r, bottomStart = r)
    }
    val bg = if (isUser) USER_BUBBLE_BG else Color(Colors.paper)
    Box(
        modifier = Modifier
            .widthIn(max = tokens.space.msgMax)
            .clip(shape)
            .background(bg)
            .border(1.dp, Color(Colors.lineSoft), shape)
            .padding(tokens.space.padMsg),
    ) {
        val showPulse = message.streaming && message.content.isEmpty()
        if (showPulse) {
            PulseDots()
        } else {
            BubbleText(
                text = message.content,
                streaming = message.streaming,
                cutoffKind = message.cutoffKind,
            )
        }
    }
}

@Composable
private fun BubbleText(text: String, streaming: Boolean, cutoffKind: String?) {
    val tokens = LocalTokens.current
    Text(
        text = buildBubbleText(text, streaming, cutoffKind),
        color = Color(Colors.ink),
        fontSize = tokens.type.base,
        lineHeight = tokens.type.base * tokens.type.lineRelaxed,
    )
}

/** Append a block-cursor while streaming, and a cutoff marker when cut short. */
private fun buildBubbleText(text: String, streaming: Boolean, cutoffKind: String?): String {
    val cursor = if (streaming) " ▍" else ""
    val cutoff = when (cutoffKind) {
        "interrupt" -> "  ⏹ interrupted"
        "barge-in" -> "  ⏹ interrupted"
        else -> ""
    }
    return text + cursor + cutoff
}

/** Three-dot thinking pulse — mirrors webui BubbleText PlaceholderPulse. */
@Composable
private fun PulseDots() {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(3) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(Color(Colors.accent).copy(alpha = 0.4f)),
            )
        }
    }
}
