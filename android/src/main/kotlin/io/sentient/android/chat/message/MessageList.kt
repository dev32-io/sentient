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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
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
    // status chips (QUEUED / SENT / FAILED) until reconciled by ChatRepository.
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

    // Pin-to-bottom follow-latest: mirrors iOS Task 4.1/4.2 semantics.
    // While pinned (default), the list scrolls to the tail on growth or token
    // change. A real user scroll-up unpins and holds position. Re-entering the
    // bottom zone re-pins automatically.
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }
    var pinned by remember { mutableStateOf(true) }
    var prevFirst by remember { mutableStateOf(0) }
    var prevOffset by remember { mutableStateOf(0) }

    // Unpin on a real user scroll-up; re-pin when back in the bottom zone.
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
            .collect { (idx, off) ->
                val movedUp = idx < prevFirst || (idx == prevFirst && off < prevOffset - 1)
                prevFirst = idx
                prevOffset = off
                if (pinned && movedUp && !atBottom) pinned = false
            }
    }
    LaunchedEffect(atBottom) { if (atBottom) pinned = true }

    // Follow latest while pinned (growth or streaming-token change).
    // Scroll to rows.lastIndex — NOT messages.lastIndex — because the LazyColumn
    // renders rows (Msg + Divider items), so messages.lastIndex is the wrong target.
    LaunchedEffect(rows.size, messages.lastOrNull()?.content) {
        if (pinned && rows.isNotEmpty()) listState.animateScrollToItem(rows.lastIndex)
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
            // Index-only key for Msg rows — the streaming bubble's ts is stamped fresh on
            // every SDK derive, so a ts-based key would churn row identity each token and
            // reset the typewriter rememberTypewriterText @State (re-revealing from zero
            // every frame). History is append-only so the index is stable; the streaming
            // bubble is always the last Msg. Matches the iOS Task 5.1/4.2 fix.
            // Pending rows use a stable "pending-<id>" key so they survive recomposition
            // without resetting any local state.
            key = { row ->
                when (row) {
                    is ChatRow.Divider -> "div-${row.key}"
                    is ChatRow.Msg -> "msg-${row.index}"
                    is ChatRow.Pending -> "pending-${row.msg.id}"
                }
            },
        ) { row ->
            when (row) {
                is ChatRow.Divider -> DayDivider(row.label)
                is ChatRow.Msg -> {
                    // The live (streaming) assistant bubble's avatar animates with the
                    // voice/cognition state; committed bubbles are static (IDLE). Mirrors
                    // the webui activeCycleMode binding (only the in-flight cycle's mark).
                    val mode = if (row.message.streaming && row.message.role == "assistant") {
                        activeMarkMode
                    } else {
                        MarkMode.IDLE
                    }
                    MessageBubble(
                        message = row.message,
                        index = row.index,
                        avatarMode = mode,
                        userName = userName,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                is ChatRow.Pending -> PendingBubble(
                    msg = row.msg,
                    userName = userName,
                    onRetry = onRetry,
                    modifier = Modifier.fillMaxWidth(),
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
// QUEUED, SENT, or FAILED state. Mirrors MessageBubble's user-aligned layout
// (right-side avatar + user bubble shape) with an inline status chip below the
// bubble body. Reconciled away by ChatRepository once the gateway echoes back
// the committed feed entry carrying the matching pendingId.
//
// testTags: msg-status-queued / msg-status-sent / msg-status-failed on the chip.
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
        MessageStatus.QUEUED -> Triple("queued", "msg-status-queued", Color(Colors.ink3))
        MessageStatus.SENT -> Triple("✓ sent", "msg-status-sent", Color(Colors.ok))
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
