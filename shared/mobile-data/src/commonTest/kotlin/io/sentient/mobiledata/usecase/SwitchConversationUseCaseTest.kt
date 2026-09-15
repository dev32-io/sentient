package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTimeoutException
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the compatibility null-switch contract and the explicit mobile fresh-chat
 * operation. Mobile route ViewModels call startFreshChat(); invoke(null) remains
 * available for older callers that intentionally rely on implicit reattachment.
 */
private class RecordingSessionsRepository : SessionsRepository {
    val newChatCalls = mutableListOf<Unit>()
    val switchCalls = mutableListOf<String>()
    val freshChatCalls = mutableListOf<Unit>()
    var switchFailure: Throwable? = null

    override fun newChatFireAndForget() { newChatCalls.add(Unit) }
    override fun startFreshChatFireAndForget() { freshChatCalls.add(Unit) }
    override fun switchToFireAndForget(sessionId: String) { switchCalls.add(sessionId) }
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> = emptyList()
    override suspend fun switchTo(sessionId: String) { switchFailure?.let { throw it } }
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
    fun `explicit fresh chat uses the fresh boundary operation`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).startFreshChat()
        assertEquals(1, repo.freshChatCalls.size)
        assertEquals(0, repo.newChatCalls.size)
    }

    @Test
    fun `non-null sessionId fires switchToFireAndForget with correct id`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).invoke("conv-123")
        assertEquals(0, repo.newChatCalls.size, "new-chat must NOT fire for an existing session")
        assertEquals(listOf("conv-123"), repo.switchCalls, "switch must fire with the correct sessionId")
    }

    @Test
    fun `acknowledged activation maps ownership and transport failures`() = runTest {
        val repo = RecordingSessionsRepository()
        val activate = ActivateSessionUseCase(repo)

        assertEquals(SessionActivationResult.AUTHORIZED, activate("owned"))
        repo.switchFailure = SessionsRequestException("not_found", "missing")
        assertEquals(SessionActivationResult.UNAVAILABLE, activate("missing"))
        repo.switchFailure = SessionsTimeoutException("session activation")
        assertEquals(SessionActivationResult.RETRYABLE_FAILURE, activate("offline"))
    }

    @Test
    fun `null sessionId does NOT fire switchToFireAndForget`() {
        val repo = RecordingSessionsRepository()
        SwitchConversationUseCase(repo).invoke(null)
        assertEquals(0, repo.switchCalls.size, "switchToFireAndForget must not be called for new chat")
    }
}
