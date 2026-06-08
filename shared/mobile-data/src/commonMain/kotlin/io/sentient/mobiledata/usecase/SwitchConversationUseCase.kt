package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobilesdk.log.createLogger

/**
 * Fire-and-forget conversation command: null starts a fresh chat, an id switches to
 * an existing session. Never awaits the backend mint/snapshot — the gateway buffers
 * the next user.message behind the pending session, so the UI never blocks.
 */
class SwitchConversationUseCase(private val sessions: SessionsRepository) {
    private val log = createLogger("data", "switch-conversation")

    operator fun invoke(sessionId: String?) {
        if (sessionId == null) {
            log.info("new-chat fire-and-forget")
            sessions.newChatFireAndForget()
        } else {
            log.info("switch fire-and-forget", mapOf("sessionId" to sessionId))
            sessions.switchToFireAndForget(sessionId)
        }
    }
}
