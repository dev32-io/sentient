package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobilesdk.connectors.SessionsRequestException
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertSame

class DeleteSessionUseCaseTest {
    @Test
    fun delete_failure_reaches_caller_unchanged() = runTest {
        val expected = SessionsRequestException("not_found", "")
        val useCase = DeleteSessionUseCase(FailingSessionsRepository(expected))

        val actual = runCatching { useCase("session-example") }.exceptionOrNull()

        assertSame(expected, actual)
    }
}

private class FailingSessionsRepository(private val failure: Throwable) : SessionsRepository {
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> = emptyList()
    override fun newChatFireAndForget() = Unit
    override fun switchToFireAndForget(sessionId: String) = Unit
    override suspend fun switchTo(sessionId: String) = Unit
    override suspend fun newChat(): String = "session-example"
    override suspend fun rename(sessionId: String, title: String) = Unit
    override suspend fun delete(sessionId: String): Unit = throw failure
}
