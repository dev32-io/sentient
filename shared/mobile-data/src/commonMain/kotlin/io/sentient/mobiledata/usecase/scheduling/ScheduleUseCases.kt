package io.sentient.mobiledata.usecase.scheduling

import io.sentient.mobiledata.data.scheduling.ScheduleRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.scheduling.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** User-scoped scheduler state. Mutations publish only acknowledged server values. */
class ScheduleUseCases(
    private val repository: ScheduleRepository,
    private val selectSession: (String) -> Unit = {},
) {
    private val _schedules = MutableStateFlow<SentientResult<List<Schedule>>>(SentientResult.Loading())
    val schedules: StateFlow<SentientResult<List<Schedule>>> = _schedules.asStateFlow()
    private val _cards = MutableStateFlow<SentientResult<List<ScheduledSessionCard>>>(SentientResult.Loading())
    val cards: StateFlow<SentientResult<List<ScheduledSessionCard>>> = _cards.asStateFlow()

    suspend fun reload(limit: Int = 100): SentientResult<List<Schedule>> {
        _schedules.value = SentientResult.Loading((_schedules.value as? SentientResult.Success)?.data)
        return repository.list(limit = limit).map { it.schedules }.also { _schedules.value = it }
    }
    suspend fun loadCards(limit: Int = 100): SentientResult<List<ScheduledSessionCard>> {
        _cards.value = SentientResult.Loading((_cards.value as? SentientResult.Success)?.data)
        return repository.cards(limit = limit).map { it.cards }.also { _cards.value = it }
    }
    suspend fun create(request: ScheduleCreateRequest): SentientResult<Schedule> =
        repository.create(request).map { it.schedule }.alsoAcknowledged()
    suspend fun edit(schedule: Schedule, changes: ScheduleChanges): SentientResult<Schedule> =
        repository.patch(schedule.scheduleId, SchedulePatchRequest(schedule.revision, changes)).map { it.schedule }.alsoAcknowledged()
    suspend fun pause(schedule: Schedule) = edit(schedule, ScheduleChanges(enabled = false))
    suspend fun resume(schedule: Schedule) = edit(schedule, ScheduleChanges(enabled = true))
    suspend fun delete(schedule: Schedule): SentientResult<Unit> =
        repository.delete(schedule.scheduleId, schedule.revision).map { Unit }.alsoAcknowledged()

    /** Uses the existing conversation activation path; cards hold no chat copy or read state. */
    fun select(card: ScheduledSessionCard) { selectSession(card.sessionId) }

    fun close() { _schedules.value = SentientResult.Loading(); _cards.value = SentientResult.Loading() }

    private suspend fun <T : Any> SentientResult<T>.alsoAcknowledged(): SentientResult<T> {
        // On either success or failure, reload authoritative state. This is rollback/reconciliation,
        // not repository caching; keep the original mutation result for the caller.
        reload()
        return this
    }
}

private inline fun <T : Any, R : Any> SentientResult<T>.map(transform: (T) -> R): SentientResult<R> = when (this) {
    is SentientResult.Success -> SentientResult.Success(transform(data))
    is SentientResult.Failure -> this
    is SentientResult.Loading -> SentientResult.Loading(partial?.let(transform))
}
