package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.RetryPolicy

data class ErrorBanner(val text: String, val canRetry: Boolean)

data class ChatUiState(
    val model: ChatModel = ChatModel(),
    val isLoading: Boolean = false,
    val banner: ErrorBanner? = null,
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
