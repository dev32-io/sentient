// ---------------------------------------------------------------------------
// ChatViewModel — thin per-conversation state holder over the shared usecase layer.
//
// Resolves the User/Connection-scoped ChatComponent from UserSessionManager (never
// the SDK directly). On init it switches the active conversation to the route's
// sessionId (null = new chat), then folds observeChat(cache.pending) → ChatUiState.
// The optimistic outbox (OutboundCache) is per-conversation: it lives and dies with
// this VM, so switching conversation = navigating = a fresh VM = clean state.
//
// Lifecycle (open/close/pause/resume) is owned by UserSessionManager, NOT here — a
// VM teardown on conversation switch must NOT disconnect the SDK.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.android.di.UserSessionManager
import io.sentient.mobiledata.outbox.OutboundCache
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.sdk.ConnectionState
import io.sentient.mobilesdk.sdk.VoiceMode
import io.sentient.mobilesdk.transport.SdkStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

class ChatViewModel(
    userSession: UserSessionManager,
    sessionId: String?,
) : ViewModel() {
    private val log = createLogger("android", "chat-viewmodel")
    private val component = userSession.component()
    private val cache = OutboundCache()

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    /** Transport + voice axis. Latest-wins StateFlow for the connection banner + composer. */
    val connection: StateFlow<ConnectionState> = component.connection.state
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STATE_SUBSCRIBE_STOP_MS), ConnectionState())

    init {
        log.info("init", mapOf("sessionId" to (sessionId ?: "<new>")))
        // Make the route's conversation active (null = new chat). The flush gate +
        // observeChat collect below pick up whatever conversation this resolves to.
        viewModelScope.launch {
            runCatching { component.switchConversation(sessionId) }
                .onFailure { log.warn("switch-failed", mapOf("reason" to (it.message ?: it::class.simpleName))) }
        }
        viewModelScope.launch {
            component.observeChat(cache.pending).collect { model ->
                // Reconcile: drop optimistic entries whose committed echo arrived.
                model.committed.mapNotNull { it.pendingId }.forEach(cache::remove)
                _state.value = ChatUiState(model = model)
            }
        }
        // Flush queued sends when the connection reaches READY (and mark prior FAILED
        // back to QUEUED is the user's retry, not auto). On non-READY, fail queued.
        viewModelScope.launch {
            component.connection.state.collect { conn ->
                if (conn.status == SdkStatus.READY) flush()
            }
        }
    }

    private val isReady: Boolean get() = connection.value.status == SdkStatus.READY

    fun send(text: String) {
        val id = UUID.randomUUID().toString()
        log.info("send", mapOf("len" to text.length, "pendingId" to id))
        cache.enqueue(id, text)
        if (isReady) flush()
    }

    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        cache.retry(pendingId)
        if (isReady) flush()
    }

    fun toggleMic() {
        if (connection.value.voiceMode == VoiceMode.ACTIVE) component.stopMic() else component.startMic()
    }

    fun toggleTts() {
        viewModelScope.launch { component.setTtsEnabled(!connection.value.prefs.ttsEnabled) }
    }

    fun interrupt() = component.interrupt()

    fun reconnect() = component.forceReconnect()

    /** Drain still-QUEUED entries: send each, mark SENT (echo reconciles by id later). */
    private fun flush() {
        for (m in cache.queued()) {
            component.sendMessage(m.text, m.id)
            cache.markSent(m.id)
        }
    }

    companion object {
        /** Keep the connection StateFlow warm briefly across config changes. */
        private const val STATE_SUBSCRIBE_STOP_MS = 5_000L
    }
}
