// ---------------------------------------------------------------------------
// ChatContent — the NEW chat surface driven by ChatUiState + ConnectionState.
//
// The chat surface (Task 3.4, rendering half). Consumes the
// KMP-layer data model (committed history + optimistic pending outbox + live
// streaming bubble + task pills) and the separate ConnectionState, so the VM
// is the only place that holds references to SDK or repo. The old chat surface
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
// status). onSend is called UNCONDITIONALLY — ChatRepository/outbox owns queuing.
//
// testTags added in this file:
//   - composer-input   → wired through Composer via "composer-input" (new tag)
//   - composer-send    → wired through Composer via "chat-send" (existing tag)
//   - mic-toggle       → wired through Composer via "chat-mic" (existing tag)
//   - banner-connection → the connection-state banner pill (lost / reconnecting)
//   - banner-chat       → the chat-side error banner
//   - content-screen    → the root Column (Maestro scoping)
//
// Banner/title-bar composables live in ChatContentBanners.kt (split to keep
// this file under the 300-line clean-code limit).
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus

/**
 * Pure composable: state in, callbacks out. No SDK / repo references.
 *
 * @param uiState       Chat model (committed + pending + live + tasks) + banner.
 * @param connection    Transport + voice state from the KMP SDK.
 * @param onSend        User submitted a text message (called unconditionally; repo queues).
 * @param onMicToggle   Mic button tapped.
 * @param onTtsToggle   TTS toggle tapped.
 * @param onInterrupt   Stop button tapped (cycle/audio abort).
 * @param onOpenHistory History drawer opened.
 * @param onNewChat     New-chat button tapped.
 * @param onReconnect   Retry button on the connection-lost banner tapped.
 * @param onRetry       User tapped the FAILED chip on a pending message — re-queues by pendingId.
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
    onRetry: (String) -> Unit = {},
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

    val affordance = loadingAffordance(
        status = connection.status,
        connectionLost = connection.connectionLost,
        hasPending = false,
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
                onRetry = onRetry,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            )
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
                onSend = onSend,
                onMicToggle = onMicToggle,
                onTtsToggle = onTtsToggle,
                onInterrupt = onInterrupt,
            )
        }

        // Connection banner floats over the top — same overlay pattern as ChatContent.
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
