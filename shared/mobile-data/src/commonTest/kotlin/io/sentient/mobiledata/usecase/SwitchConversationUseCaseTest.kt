package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the eager-mint contract for the new-chat route (sessionId == null).
 *
 * When the ChatViewModel is created with sessionId=null (new chat), it calls
 * switchConversation(null), which MUST fire newChatFireAndForget() exactly once —
 * never switchToFireAndForget. This is the A-series eager-mint wire: the gateway
 * buffers the first user.message behind the pending session.new mint.
 */
private class RecordingSessionsRepository : SessionsRepository {
    val newChatCalls = mutableListOf<Unit>()
    val switchCalls = mutableListOf<String>()

    override fun newChatFireAndForget() { newChatCalls.add(Unit) }
    override fun switchToFireAndForget(sessionId: String) { switchCalls.add(sessionId) }
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> = emptyList()
    override suspend fun switchTo(sessionId: String) {}
    override suspend fun newChat(): String = "fake-id"
    override suspend fun rename(sessionId: String, title: String) {}
    override suspend fun delete(sessionId: String) {}
}

class SwitchConversationUseCaseTest {

    @Test
    fun `null sessionId fires newChatFireAndForget exactly once`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).invoke(null)
        assertEquals(1, repo.newChatCalls.size, "new-chat must fire exactly once on null sessionId")
        assertEquals(0, repo.switchCalls.size, "switch must NOT fire for a new-chat route")
    }

    @Test
    fun `non-null sessionId fires switchToFireAndForget with correct id`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).invoke("conv-123")
        assertEquals(0, repo.newChatCalls.size, "new-chat must NOT fire for an existing session")
        assertEquals(listOf("conv-123"), repo.switchCalls, "switch must fire with the correct sessionId")
    }

    @Test
    fun `null sessionId does NOT fire switchToFireAndForget`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).invoke(null)
        assertEquals(0, repo.switchCalls.size, "switchToFireAndForget must not be called for new chat")
    }
}
