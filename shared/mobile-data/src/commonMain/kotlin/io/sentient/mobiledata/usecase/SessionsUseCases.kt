package io.sentient.mobiledata.usecase

import io.sentient.mobiledata.data.SessionSummary
import io.sentient.mobiledata.data.SessionsRepository
import io.sentient.mobilesdk.connectors.SessionsRequestException
import kotlinx.coroutines.CancellationException

class ObserveSessionsUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(limit: Int, offset: Int = 0): List<SessionSummary> =
        sessions.list(limit, offset)
}

enum class SessionActivationResult { AUTHORIZED, UNAVAILABLE, RETRYABLE_FAILURE }

/** Authoritative ownership check: success means matching session.switched arrived. */
class ActivateSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String): SessionActivationResult = try {
        sessions.switchTo(sessionId)
        SessionActivationResult.AUTHORIZED
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: SessionsRequestException) {
        if (failure.code == "not_found" || failure.code == "forbidden") {
            SessionActivationResult.UNAVAILABLE
        } else {
            SessionActivationResult.RETRYABLE_FAILURE
        }
    } catch (_: Throwable) {
        SessionActivationResult.RETRYABLE_FAILURE
    }
}

class RenameSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String, title: String) = sessions.rename(sessionId, title)
}

class DeleteSessionUseCase(private val sessions: SessionsRepository) {
    suspend operator fun invoke(sessionId: String) = sessions.delete(sessionId)
}
