package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository

class ObserveSessionsUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(limit: Int, offset: Int = 0): List<SessionSummary> =
        sessions.list(limit, offset)
}

class RenameSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String, title: String) = sessions.rename(sessionId, title)
}

class DeleteSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String) = sessions.delete(sessionId)
}
