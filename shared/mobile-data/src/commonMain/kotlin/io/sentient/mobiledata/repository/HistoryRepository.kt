package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

data class SessionRowData(val id: String, val title: String, val updatedAtMs: Long)

class HistoryRepository(private val fetch: suspend () -> List<SessionRowData>) {
    private val log = createLogger("data", "history")
    private var cache: List<SessionRowData> = emptyList()

    fun seedCache(rows: List<SessionRowData>) { cache = rows }
    fun cached(): List<SessionRowData> = cache

    fun load(): Flow<SentientResult<List<SessionRowData>>> = flow {
        log.debug("load.cache", mapOf("cached" to cache.size))
        emit(SentientResult.Loading(partial = cache))
        runCatching { fetch() }.fold(
            onSuccess = {
                cache = it
                log.info("load.ok", mapOf("count" to it.size))
                emit(SentientResult.Success(it))
            },
            onFailure = {
                log.warn("load.failed", mapOf("reason" to (it.message ?: "error")))
                emit(SentientResult.Failure(SentientError.Timeout("Couldn't load chats", cause = it)))
            },
        )
    }
}
