package io.sentient.mobiledata.data

import io.sentient.mobilesdk.connectors.SessionsRequestException
import io.sentient.mobilesdk.connectors.SessionsTransportException
import kotlinx.coroutines.CancellationException

/** A row in the session list, mapped from the SDK's SessionRow (UI-agnostic). */
data class SessionSummary(
    val id: String,
    val title: String,
    val updatedAtMs: Long,
)

/** Stateless session-management surface. Pure delegation to the SDK. */
interface SessionsRepository {
    suspend fun list(limit: Int, offset: Int): List<SessionSummary>

    /** Legacy compatibility path; intent may be implicit. */
    fun newChatFireAndForget()

    /** Explicitly unbind the old conversation without awaiting the mint. */
    fun startFreshChatFireAndForget() = newChatFireAndForget()

    /** Fire-and-forget switch — sends session.switch, never awaits the snapshot. */
    fun switchToFireAndForget(sessionId: String)

    suspend fun switchTo(sessionId: String)
    suspend fun newChat(): String
    suspend fun rename(sessionId: String, title: String)

    @Throws(SessionsRequestException::class, SessionsTransportException::class, CancellationException::class)
    suspend fun delete(sessionId: String)
}
