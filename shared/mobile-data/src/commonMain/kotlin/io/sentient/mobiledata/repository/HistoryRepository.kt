package io.sentient.mobiledata.repository

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

data class SessionRowData(val id: String, val title: String, val updatedAtMs: Long)

class HistoryRepository(private val fetch: suspend () -> List<SessionRowData>) {
    private var cache: List<SessionRowData> = emptyList()

    fun seedCache(rows: List<SessionRowData>) { cache = rows }
    fun cached(): List<SessionRowData> = cache

    fun load(): Flow<SentientResult<List<SessionRowData>>> = flow {
        emit(SentientResult.Loading(partial = cache))
        runCatching { fetch() }.fold(
            onSuccess = { cache = it; emit(SentientResult.Success(it)) },
            onFailure = { emit(SentientResult.Failure(SentientError.Timeout("Couldn't load chats", cause = it))) },
        )
    }
}
