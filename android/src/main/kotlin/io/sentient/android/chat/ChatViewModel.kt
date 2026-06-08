package io.sentient.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobiledata.repository.OutboxRepository
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ChatViewModel(
    private val chatRepo: ChatRepository,            // committed + live + pending → ChatModel stream
    private val outboxRepo: OutboxRepository,        // optimistic send queue (send/retry)
    private val onOpen: suspend () -> Unit,          // acquire + connect SDK (chat-scoped); injected by session factory
    private val onClose: () -> Unit,                 // disconnect + cancel scope (screen exit)
    private val onForeground: suspend () -> Unit = {},  // session.resume() on app foreground
    private val onBackground: () -> Unit = {},          // session.pause() on app background
    private val presence: PresenceCoordinator? = null,
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        log.info("init")
        viewModelScope.launch { onOpen() }                      // background; UI usable immediately
        viewModelScope.launch {
            chatRepo.chatStream.collect { result ->
                val next = reduceChatUi(_state.value, result)
                log.debug(
                    "uiState",
                    mapOf(
                        "messages" to next.model.committed.size,
                        "pending" to next.model.pending.size,
                        "live" to (next.model.live != null),
                        "loading" to next.isLoading,
                        "banner" to (next.banner != null),
                    ),
                )
                _state.value = next
            }
        }
        presence?.bind(
            onForeground = { viewModelScope.launch { onForeground() } },
            onBackground = { onBackground() },
        )
    }

    fun send(text: String) {
        log.info("send", mapOf("len" to text.length))
        outboxRepo.send(text)
    }

    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        outboxRepo.retry(pendingId)
    }

    override fun onCleared() {
        log.info("onCleared")
        presence?.unbind()
        onClose()
    }
}
