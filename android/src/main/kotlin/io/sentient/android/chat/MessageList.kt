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
package io.sentient.android.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage

private const val PLACEHOLDER = "Start a conversation…"

@Composable
fun MessageList(
    messages: List<ChatMessage>,
    activeMarkMode: MarkMode = MarkMode.IDLE,
    userName: String = "You",
    modifier: Modifier = Modifier,
) {
    if (messages.isEmpty()) {
        EmptyState(modifier = modifier)
        return
    }
    val tokens = LocalTokens.current
    val listState = rememberLazyListState()

    // Compute rows once — shared by the LazyColumn items() and the scroll effect
    // so both reference the same list and rows.lastIndex is the correct tail index.
    val rows = chatRows(messages, nowMs = System.currentTimeMillis())

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
            key = { row ->
                when (row) {
                    is ChatRow.Divider -> "div-${row.key}"
                    is ChatRow.Msg -> "msg-${row.index}"
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
