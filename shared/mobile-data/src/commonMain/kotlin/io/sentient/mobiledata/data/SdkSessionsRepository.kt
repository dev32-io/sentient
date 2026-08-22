package io.sentient.mobiledata.data

import io.sentient.mobilesdk.sdk.SentientSdk

/** SDK-backed SessionsRepository: maps SDK SessionRow → SessionSummary; commands delegate. */
class SdkSessionsRepository(private val sdk: SentientSdk) : SessionsRepository {
    override suspend fun list(limit: Int, offset: Int): List<SessionSummary> =
        sdk.listSessions(limit = limit, offset = offset).items.map {
            SessionSummary(id = it.sessionId, title = it.title, updatedAtMs = it.lastActiveAt)
        }

    override fun newChatFireAndForget() = sdk.sendNewChat()

    override fun startFreshChatFireAndForget() = sdk.startFreshChat()

    override fun switchToFireAndForget(sessionId: String) = sdk.sendSwitchSession(sessionId)

    override suspend fun switchTo(sessionId: String) { sdk.switchSession(sessionId) }

    override suspend fun newChat(): String = sdk.newChat()

    override suspend fun rename(sessionId: String, title: String) { sdk.renameSession(id = sessionId, title = title) }
    override suspend fun delete(sessionId: String) { sdk.deleteSession(id = sessionId) }
}
