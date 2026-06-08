package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionsRepository

/** Make [sessionId] the active conversation; null starts a fresh one. Returns the active id. */
class SwitchConversationUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String?): String =
        if (sessionId == null) sessions.newChat() else { sessions.switchTo(sessionId); sessionId }
}
