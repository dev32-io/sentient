package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.result.RetryPolicy

data class ErrorBanner(val text: String, val canRetry: Boolean)

/** Copy shown when a reconnect re-establish was rejected (spec §14). */
internal const val REOPEN_FAILED_NOTICE = "Couldn't reopen that chat — started a new one."

data class ChatUiState(
    val model: ChatModel = ChatModel(),
    val isLoading: Boolean = false,
    val banner: ErrorBanner? = null,
    /**
     * Non-null while the ReopenFailed one-shot notice is visible. The VM sets this
     * when [SdkEvent.ReopenFailed] arrives and clears it on acknowledgement (tap or
     * auto-dismiss). The notice is unrelated to [banner] (which reflects repo
     * failures); they are independent UI elements.
     */
    val reopenFailedNotice: String? = null,
    /**
     * Outstanding L3 permission-confirm prompt (design spec §7.1/§5.3), or null.
     * Mirrors the head of `ChatComponent.permissions` (the SDK's still-open prompt
     * list — SessionRuntime blocks the turn on one prompt at a time) via
     * ChatViewModel.startPermissionCollecting; cleared optimistically on Allow/Deny
     * or when that list itself empties (server `permission.resolved`, any outcome).
     * UNLIKE [reopenFailedNotice], this is a decision gate, not a passive notice —
     * see ChatViewModel.armLocalTimeoutFallback for the one place a LOCAL clear can
     * also happen, and [shouldClearOnLocalTimeout] for the invariant that guards it.
     */
    val pendingPermissionRequest: PermissionPrompt? = null,
) {
    /**
     * True while an existing-session switch is loading its history snapshot — the
     * message list shows a centered spinner over the cleared list. The composer is
     * NEVER gated on this; a brand-new chat stays false.
     */
    val historyLoading: Boolean get() = model.historyLoading
}

fun reduceChatUi(prev: ChatUiState, result: SentientResult<ChatModel>): ChatUiState = when (result) {
    is SentientResult.Loading -> prev.copy(isLoading = true, model = result.partial ?: prev.model)
    is SentientResult.Success -> ChatUiState(model = result.data, isLoading = false, banner = null)
    is SentientResult.Failure -> prev.copy(
        isLoading = false,
        banner = ErrorBanner(result.error.userMessage, canRetry = result.error.retry != RetryPolicy.None),
    )
}

/**
 * Guards ChatViewModel's local-timeout-fallback clearing decision against a stale
 * job firing after a NEWER request has replaced the one it was armed for (design
 * spec §7.1). Display-only: this decides nothing security-relevant — only whether
 * the LOCAL dialog should still be told to go away. Mirrors Task 9's iOS
 * `PermissionPromptFSM.reduce(..., .localTimeoutFired)` guard.
 */
internal fun shouldClearOnLocalTimeout(current: PermissionPrompt?, firedForRequestId: String): Boolean =
    current?.requestId == firedForRequestId
