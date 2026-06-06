package io.sentient.android.chat

import io.sentient.mobiledata.model.ChatModel
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.RetryPolicy

data class ErrorBanner(val text: String, val canRetry: Boolean)

data class ChatUiState(
    val model: ChatModel = ChatModel(),
    val isLoading: Boolean = false,
    val banner: ErrorBanner? = null,
)

fun reduceChatUi(prev: ChatUiState, result: SentientResult<ChatModel>): ChatUiState = when (result) {
    is SentientResult.Loading -> prev.copy(isLoading = true, model = result.partial ?: prev.model)
    is SentientResult.Success -> ChatUiState(model = result.data, isLoading = false, banner = null)
    is SentientResult.Failure -> prev.copy(
        isLoading = false,
        banner = ErrorBanner(result.error.userMessage, canRetry = result.error.retry != RetryPolicy.None),
    )
}
