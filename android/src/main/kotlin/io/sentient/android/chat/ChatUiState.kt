package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
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
