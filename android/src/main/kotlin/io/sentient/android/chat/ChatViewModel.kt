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
        // Make the route's conversation active (null = new chat). Fire-and-forget:
        // the usecase no longer suspends or throws — no launch, no runCatching. The
        // gateway buffers user.message behind the pending mint, so the UI never blocks.
        component.switchConversation(sessionId)
        viewModelScope.launch {
            component.observeChat(cache.pending).collect { model ->
                // Reconcile: drop optimistic entries whose committed echo arrived.
                model.committed.mapNotNull { it.pendingId }.forEach(cache::remove)
                _state.value = ChatUiState(model = model)
            }
        }
        // Drain the outbox on every READY emission (rising edge): flushIfReady is a
        // no-op when not READY and when nothing's queued, so calling it on each
        // emission is safe and idempotent.
        viewModelScope.launch {
            component.connection.state.collect { conn ->
                component.sendMessage.flushIfReady(cache, conn.status)
            }
        }
    }

    private val isReady: Boolean get() = connection.value.status == SdkStatus.READY

    fun send(text: String) {
        val id = UUID.randomUUID().toString()
        log.info("send", mapOf("len" to text.length, "pendingId" to id))
        cache.enqueue(id, text)
        if (isReady) component.sendMessage.flushIfReady(cache, connection.value.status)
    }

    fun retry(pendingId: String) {
        log.info("retry", mapOf("pendingId" to pendingId))
        cache.retry(pendingId)
        // A stuck queued message: reconnect first (user-driven recovery), then drain.
        if (!isReady) component.forceReconnect()
        component.sendMessage.flushIfReady(cache, connection.value.status)
    }

    fun toggleMic() {
        if (connection.value.voiceMode == VoiceMode.ACTIVE) component.stopMic() else component.startMic()
    }

    fun toggleTts() {
        viewModelScope.launch { component.setTtsEnabled(!connection.value.prefs.ttsEnabled) }
    }

    fun interrupt() = component.interrupt()

    fun reconnect() = component.forceReconnect()

    companion object {
        /** Keep the connection StateFlow warm briefly across config changes. */
        private const val STATE_SUBSCRIBE_STOP_MS = 5_000L
    }
}
