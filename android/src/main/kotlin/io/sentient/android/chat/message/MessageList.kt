// ---------------------------------------------------------------------------
// MessageList — the scrolling chat history, mirroring the webui MessageList +
// ChatView (gateway/webui/src/components/chat/message-list.tsx, chat-view.tsx).
//
// A LazyColumn of MessageBubbles with gapMsg (32dp) between messages. Pin-to-
// bottom follow-latest: while pinned (default), scrolls on growth or streaming-
// token change. User scroll-up unpins; re-entering the bottom zone re-pins.
// Empty state shows the "Start a conversation…" placeholder. The list owns no
// state beyond its scroll position — it reads SdkState.messages, passed down.
//
// testTag `chat-message-list` is on the LazyColumn so the e2e driver scopes its
// bubble assertions to the list.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.message

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.android.chat.voice.MarkMode
import io.sentient.android.theme.LocalTokens
import io.sentient.mobiledata.outbox.MessageStatus
import io.sentient.mobiledata.outbox.PendingMessage
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage

private const val PLACEHOLDER = "Start a conversation…"

@Composable
fun MessageList(
    messages: List<ChatMessage>,
    activeMarkMode: MarkMode = MarkMode.IDLE,
    userName: String = "You",
    modifier: Modifier = Modifier,
    // Optimistic pending rows appended AFTER committed history. Rendered with
    // status chips (QUEUED / FAILED) until reconciled away on the committed echo.
    pending: List<PendingMessage> = emptyList(),
    // Invoked when the user taps the FAILED chip on a specific pending message.
    onRetry: (String) -> Unit = {},
) {
    if (messages.isEmpty() && pending.isEmpty()) {
        EmptyState(modifier = modifier)
        return
    }
    val tokens = LocalTokens.current
    val listState = rememberLazyListState()

    // Compute rows once — shared by the LazyColumn items() and the scroll effect
    // so both reference the same list and rows.lastIndex is the correct tail index.
    // Pending rows are appended after committed history (no day-dividers for
    // pending — they are optimistic and transient, not yet part of the timeline).
    val rows: List<ChatRow> = buildList {
        addAll(chatRows(messages, nowMs = System.currentTimeMillis()))
        pending.forEach { add(ChatRow.Pending(it)) }
    }

    // The latest assistant bubble carries the live mark animation even after it
    // commits, so the avatar ring persists through the whole thinking+speaking
    // window (the post-commit TTS tail has no streaming bubble). -1 when none.
    val lastAssistant = messages.indexOfLast { it.role == "assistant" }

    // Initial history positioning is intentionally separate from live sends.
    // It is non-animated and runs once when the first snapshot has rows.
    var positionedHistory by remember { mutableStateOf(false) }
    var anchorState by remember { mutableStateOf(SendAnchorState()) }
    val sendIdentities = rows.mapNotNull { row ->
        when (row) {
            is ChatRow.Pending -> sendAnchorIdentity(row.msg.id)
            is ChatRow.Msg -> row.message.pendingId?.takeIf { row.message.role == "user" }?.let(::sendAnchorIdentity)
            is ChatRow.Divider -> null
        }
    }.toSet()
    LaunchedEffect(sendIdentities, rows.size) {
        if (!positionedHistory && rows.isNotEmpty()) {
            listState.scrollToItem(rows.lastIndex)
            positionedHistory = true
            // Existing pending/history rows are part of the initial snapshot, not sends
            // observed by this live list.
            anchorState = SendAnchorState(sendIdentities)
            return@LaunchedEffect
        }
        val (next, newlySent) = reduceSendAnchor(anchorState, sendIdentities)
        anchorState = next
        if (newlySent != null) {
            val target = rows.indexOfFirst { row ->
                when (row) {
                    is ChatRow.Pending -> sendAnchorIdentity(row.msg.id) == newlySent
                    is ChatRow.Msg -> row.message.pendingId?.let(::sendAnchorIdentity) == newlySent
                    is ChatRow.Divider -> false
                }
            }
            if (target >= 0) listState.animateScrollToItem(target, 0)
        }
    }

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .testTag("chat-message-list"),
        state = listState,
        contentPadding = PaddingValues(
            horizontal = tokens.space.lg,
            vertical = tokens.space.lg,
        ),
        verticalArrangement = Arrangement.spacedBy(tokens.space.gapMsg),
    ) {
        items(
            rows,
            // Stable per-message key for Msg rows — keyed on replyId first (see
            // messageRowKey): a steered turn's two replies share one turnId but
            // rotate replyId, so turnId alone would collapse them into one key
            // (Compose throws on the duplicate). The live streaming bubble and its
            // committed twin still share replyId, so the streaming→committed
            // handoff is the SAME row (grows in place, no remount); replyId never
            // churns mid-reveal, unlike ts.
            // Pending rows use a stable "pending-<id>" key so they survive recomposition.
            key = { row ->
                when (row) {
                    is ChatRow.Divider -> "div-${row.key}"
                    is ChatRow.Msg -> messageRowKey(row.message, row.index)
                    is ChatRow.Pending -> "send-${row.msg.id}"
                }
            },
        ) { row ->
            when (row) {
                is ChatRow.Divider -> DayDivider(row.label)
                is ChatRow.Msg -> {
                    // The assistant avatar animates while streaming AND — so the ring
                    // covers the whole thinking+speaking window — while it is the LATEST
                    // assistant bubble and the active mode is thinking/speaking (the
                    // post-commit TTS tail has no streaming bubble). Mirrors canInterrupt
                    // (cognition != IDLE || isSpeaking). Other committed bubbles stay IDLE.
                    val mode = when {
                        row.message.role != "assistant" -> MarkMode.IDLE
                        row.message.streaming -> activeMarkMode
                        row.index == lastAssistant &&
                            (activeMarkMode == MarkMode.THINKING || activeMarkMode == MarkMode.SPEAKING) -> activeMarkMode
                        else -> MarkMode.IDLE
                    }
                    MessageBubble(
                        message = row.message,
                        index = row.index,
                        avatarMode = mode,
                        userName = userName,
                        modifier = Modifier
                            .fillMaxWidth()
                            .let { base ->
                                if (row.message.role == "user" && row.message.pendingId != null) {
                                    base.testTag("chat-user-row-${row.message.pendingId}")
                                } else base
                            },
                    )
                }
                is ChatRow.Pending -> PendingBubble(
                    msg = row.msg,
                    userName = userName,
                    onRetry = onRetry,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("chat-user-row-${row.msg.id}"),
                )
            }
        }
    }
}

@Composable
private fun EmptyState(modifier: Modifier = Modifier) {
    val tokens = LocalTokens.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(tokens.space.xl),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = PLACEHOLDER,
            color = Color(Colors.ink3),
            fontSize = tokens.type.base,
        )
    }
}

// ---------------------------------------------------------------------------
// PendingBubble — optimistic user-side bubble while the outbox entry is in
// QUEUED or FAILED state. There is NO "sent" state: the bubble is reconciled
// AWAY (cache.remove) on its committed echo, never promoted to a "✓ sent" chip.
// Mirrors MessageBubble's user-aligned layout (right-side avatar + user bubble
// shape) with an inline status chip below the bubble body.
//
// testTags: msg-status-queued / msg-status-failed on the chip.
// ---------------------------------------------------------------------------

private val FLUSH_CORNER_PENDING = 6.dp
private val STATUS_CHIP_RADIUS = 8.dp
private val USER_BUBBLE_BG_PENDING: Color
    @Composable get() = lerp(Color(Colors.paper), Color(Colors.sage), 0.16f)

@Composable
internal fun PendingBubble(
    msg: PendingMessage,
    userName: String = "You",
    onRetry: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.Top,
    ) {
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
        ) {
            // Sender label — mirrors MessageMeta for the user role.
            Text(
                text = userName,
                color = Color(Colors.ink3),
                fontSize = tokens.type.sm,
            )
            // Bubble body — user shape (flush top-right corner).
            val r = tokens.radii.lg
            val shape = RoundedCornerShape(
                topStart = r, topEnd = FLUSH_CORNER_PENDING,
                bottomEnd = r, bottomStart = r,
            )
            Box(
                modifier = Modifier
                    .widthIn(max = tokens.space.msgMax)
                    .clip(shape)
                    .background(USER_BUBBLE_BG_PENDING)
                    .border(1.dp, Color(Colors.lineSoft), shape)
                    .padding(tokens.space.padMsg),
            ) {
                Text(
                    text = msg.text,
                    color = Color(Colors.ink),
                    fontSize = tokens.type.base,
                    lineHeight = tokens.type.base * tokens.type.lineRelaxed,
                )
            }
            // Status chip — QUEUED / SENT / FAILED (FAILED is tappable → retry).
            PendingStatusChip(status = msg.status, onRetry = { onRetry(msg.id) })
        }
        io.sentient.android.chat.brand.InitialAvatar(
            name = userName,
            size = 28.dp,
            modifier = Modifier.padding(start = tokens.space.md),
            background = Color(Colors.accent50),
        )
    }
}

@Composable
private fun PendingStatusChip(status: MessageStatus, onRetry: () -> Unit = {}) {
    val tokens = LocalTokens.current
    val (label, tagName, chipColor) = when (status) {
        MessageStatus.QUEUED -> Triple("Sending…", "msg-status-queued", Color(Colors.ink3))
        MessageStatus.FAILED -> Triple("↺ Retry", "msg-status-failed", Color(Colors.stop))
    }
    val clickModifier = if (status == MessageStatus.FAILED) {
        Modifier.clickable(onClick = onRetry)
    } else {
        Modifier
    }
    Text(
        text = label,
        color = chipColor,
        fontSize = tokens.type.sm,
        modifier = Modifier
            .background(chipColor.copy(alpha = 0.10f), RoundedCornerShape(STATUS_CHIP_RADIUS))
            .then(clickModifier)
            .padding(horizontal = tokens.space.sm, vertical = 2.dp)
            .testTag(tagName),
    )
}
