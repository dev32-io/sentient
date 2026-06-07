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
// renders GFM markdown via typewriter reveal while still streaming.
//
// Markdown: GFM via mikepenz multiplatform-markdown-renderer (m3), themed to
// Dusk (ink text, accent links, bgElev code) — mirrors the webui `marked` path.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
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
    avatarMode: MarkMode = MarkMode.IDLE,
    userName: String = "You",
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    val isUser = message.role == "user"
    val isAssistant = message.role == "assistant"
    val arrangement = if (isUser) Arrangement.End else Arrangement.Start
    // Single testTag per node — Compose semantics resolves conflicts by outer-wins,
    // so stacking two .testTag() calls produces only one resource-id (the outer).
    // Assistant bubbles use "assistant-bubble" so Maestro can assert any assistant
    // reply appeared; user bubbles use "message-bubble-<index>" for index-based queries.
    val bubbleTag = if (isAssistant) "assistant-bubble" else "$BUBBLE_TAG_PREFIX$index"
    Row(
        modifier = modifier.testTag(bubbleTag),
        horizontalArrangement = arrangement,
        verticalAlignment = Alignment.Top,
    ) {
        if (isUser) {
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
            ) {
                MessageMeta(message, userName)
                BubbleBody(message = message, isUser = true, avatarMode = avatarMode)
            }
            BubbleAvatar(message = message, avatarMode = avatarMode, userName = userName)
        } else {
            BubbleAvatar(message = message, avatarMode = avatarMode, userName = userName)
            Column(verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
                MessageMeta(message, userName)
                BubbleBody(message = message, isUser = false, avatarMode = avatarMode)
            }
        }
    }
}

/** Assistant → SentientMark (animated for the live bubble); user → tinted initial circle. */
@Composable
private fun BubbleAvatar(message: ChatMessage, avatarMode: MarkMode, userName: String) {
    val tokens = LocalTokens.current
    val gap = tokens.space.md
    if (message.role == "user") {
        InitialAvatar(
            name = userName,
            size = AVATAR_SIZE,
            modifier = Modifier.padding(start = gap),
            background = Color(Colors.accent50),
        )
    } else {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.padding(end = gap),
        ) {
            SentientMark(size = AVATAR_SIZE, mode = avatarMode)
            AvatarRipple(
                active = avatarMode == MarkMode.SPEAKING ||
                    avatarMode == MarkMode.LISTENING ||
                    avatarMode == MarkMode.THINKING,
                modifier = Modifier.size(AVATAR_SIZE),
            )
        }
    }
}

@Composable
private fun BubbleBody(message: ChatMessage, isUser: Boolean, avatarMode: MarkMode) {
    val tokens = LocalTokens.current
    val r = tokens.radii.lg
    val shape = if (isUser) {
        RoundedCornerShape(topStart = r, topEnd = FLUSH_CORNER, bottomEnd = r, bottomStart = r)
    } else {
        RoundedCornerShape(topStart = FLUSH_CORNER, topEnd = r, bottomEnd = r, bottomStart = r)
    }
    val bg = if (isUser) USER_BUBBLE_BG else Color(Colors.paper)
    val isSpeaking = !isUser && avatarMode == MarkMode.SPEAKING
    Box(
        modifier = Modifier
            .widthIn(max = tokens.space.msgMax)
            .clip(shape)
            .background(bg)
            .bubbleSpeakingWave(active = isSpeaking)
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
                tools = message.tools,
            )
        }
    }
}

@Composable
private fun BubbleText(
    text: String,
    streaming: Boolean,
    cutoffKind: String?,
    tools: List<TaskSnapshotItem> = emptyList(),
) {
    val tokens = LocalTokens.current
    // GFM rendered to Compose (mikepenz). Streaming reveals text via typewriter; the
    // cutoff marker renders as a separate row below so it stays outside the markdown block flow.
    val shown = rememberTypewriterText(text, streaming)
    val body = TextStyle(
        color = Color(Colors.ink),
        fontSize = tokens.type.base,
        lineHeight = tokens.type.base * tokens.type.lineRelaxed,
    )
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
        Markdown(
            content = shown,
            colors = markdownColor(
                text = Color(Colors.ink),
                codeBackground = Color(Colors.bgElev),
                inlineCodeBackground = Color(Colors.bgElev),
            ),
            typography = markdownTypography(
                // Right-size headings for chat bubbles — Material display* defaults
                // are oversized in a message bubble (parity with the iOS bubble).
                h1 = body.copy(fontSize = tokens.type.xl, fontWeight = FontWeight.Bold),
                h2 = body.copy(fontSize = tokens.type.lg, fontWeight = FontWeight.Bold),
                h3 = body.copy(fontSize = tokens.type.base, fontWeight = FontWeight.Bold),
                text = body,
                paragraph = body,
                ordered = body,
                bullet = body,
                list = body,
                textLink = TextLinkStyles(
                    style = SpanStyle(
                        color = Color(Colors.accent),
                        textDecoration = TextDecoration.Underline,
                    ),
                ),
            ),
        )
        if (cutoffLabel(cutoffKind) != null) {
            Text(text = "⏹ interrupted", color = Color(Colors.ink3), fontSize = tokens.type.sm)
        }
        if (tools.isNotEmpty()) ToolPillStrip(tools)
    }
}

/** Interrupt / barge-in both surface as "interrupted"; null when not cut short. */
private fun cutoffLabel(cutoffKind: String?): String? = when (cutoffKind) {
    "interrupt", "barge-in" -> "interrupted"
    else -> null
}

/** Three-dot thinking pulse — mirrors webui BubbleText PlaceholderPulse. */
@Composable
private fun PulseDots() {
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.testTag("pulse-dots"),
    ) {
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
