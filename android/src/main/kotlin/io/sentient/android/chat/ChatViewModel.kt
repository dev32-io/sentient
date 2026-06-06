package io.sentient.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ChatViewModel(
    private val repo: ChatRepository,
    private val onOpen: suspend () -> Unit,   // acquire + connect SDK (chat-scoped); injected by session factory
    private val onClose: () -> Unit,          // disconnect SDK
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        log.info("init")
        viewModelScope.launch { onOpen() }                      // background; UI usable immediately
        viewModelScope.launch {
            repo.chatStream.collect { _state.value = reduceChatUi(_state.value, it) }
        }
    }

    fun send(text: String) {
        log.info("send", mapOf("len" to text.length))
        repo.send(text)
    }

    override fun onCleared() {
        log.info("onCleared")
        onClose()
    }
}
