// ---------------------------------------------------------------------------
// MessageList — the scrolling chat history, mirroring the webui MessageList +
// ChatView (gateway/webui/src/components/chat/message-list.tsx, chat-view.tsx).
//
// A LazyColumn of MessageBubbles with gapMsg (32dp) between messages. Auto-
// scrolls to the latest message whenever the list grows OR the last bubble's
// content changes (streaming tokens), mirroring the webui useFollowLatest hook.
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
    modifier: Modifier = Modifier,
) {
    if (messages.isEmpty()) {
        EmptyState(modifier = modifier)
        return
    }
    val tokens = LocalTokens.current
    val listState = rememberLazyListState()

    // Follow-latest: scroll to the last message when the count grows or the
    // tail content changes (streaming). Keyed on both so each token nudges it.
    val lastIndex = messages.lastIndex
    LaunchedEffect(messages.size, messages.lastOrNull()?.content) {
        if (lastIndex >= 0) listState.animateScrollToItem(lastIndex)
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
        itemsIndexed(messages, key = { i, m -> "${m.ts}-$i" }) { i, m ->
            MessageBubble(message = m, index = i, modifier = Modifier.fillMaxWidth())
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
