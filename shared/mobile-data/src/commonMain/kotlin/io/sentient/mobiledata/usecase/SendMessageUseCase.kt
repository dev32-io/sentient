package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.ConversationRepository

/** Fire an outbound message through the repo. Enqueue/optimism is the VM's OutboundCache. */
class SendMessageUseCase(private val conversation: ConversationRepository) {
    operator fun invoke(text: String, pendingId: String) = conversation.send(text, pendingId)
}
