package io.sentient.mobiledata.usecase.scheduling

import io.sentient.mobiledata.data.scheduling.ScheduleRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.scheduling.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val PAGE_SIZE = 100
private const val MAX_INBOX_CARDS = 10_000
private const val MAX_INBOX_PAGES = 10_000

/** User-scoped scheduler state. Mutations publish only acknowledged server values. */
class ScheduleUseCases(
    private val repository: ScheduleRepository,
    private val selectSession: (String) -> Unit = {},
) {
    private val scheduleOperations = Mutex()
    private val cardOperations = Mutex()
    private val _schedules = MutableStateFlow<SentientResult<List<Schedule>>>(SentientResult.Loading())
    val schedules: StateFlow<SentientResult<List<Schedule>>> = _schedules.asStateFlow()
    private val _cards = MutableStateFlow<SentientResult<List<ScheduledSessionCard>>>(SentientResult.Loading())
    val cards: StateFlow<SentientResult<List<ScheduledSessionCard>>> = _cards.asStateFlow()
    private var generation = 0L
    private var closed = false

    suspend fun reload(limit: Int = PAGE_SIZE): SentientResult<List<Schedule>> = scheduleOperations.withLock {
        if (closed) return@withLock SentientResult.Loading()
        loadSchedules(generation, limit)
    }

    /** Loads every retained inbox page up to the server's supported operator cap. */
    suspend fun loadCards(limit: Int = PAGE_SIZE): SentientResult<List<ScheduledSessionCard>> = cardOperations.withLock {
        if (closed) return@withLock SentientResult.Loading()
        require(limit in 1..PAGE_SIZE)
        loadCards(generation, limit)
    }

    suspend fun create(request: ScheduleCreateRequest): SentientResult<Schedule> = mutateSchedule {
        repository.create(request).map { it.schedule }
    }

    suspend fun edit(schedule: Schedule, changes: ScheduleChanges): SentientResult<Schedule> = mutateSchedule {
        repository.patch(schedule.scheduleId, SchedulePatchRequest(schedule.revision, changes)).map { it.schedule }
    }

    suspend fun pause(schedule: Schedule) = edit(schedule, ScheduleChanges(enabled = false))
    suspend fun resume(schedule: Schedule) = edit(schedule, ScheduleChanges(enabled = true))

    suspend fun delete(schedule: Schedule): SentientResult<Unit> = mutateSchedule {
        repository.delete(schedule.scheduleId, schedule.revision).map { Unit }
    }

    suspend fun clearCard(sessionId: String): SentientResult<ScheduledSessionCardsClearResponse> = cardOperations.withLock {
        if (closed) return@withLock SentientResult.Loading()
        val operation = generation
        val result = repository.clearCard(sessionId)
        if (result is SentientResult.Success && isCurrent(operation)) {
            _cards.value = SentientResult.Success(currentCards().filterNot { it.sessionId == sessionId })
            loadCards(operation, PAGE_SIZE)
        }
        result
    }

    suspend fun clearCards(): SentientResult<ScheduledSessionCardsClearResponse> =
        clearCards(currentCards().map(ScheduledSessionCard::occurrenceId))

    /** Explicit targets let callers retry without expanding the confirmed clear set. */
    suspend fun clearCards(occurrenceIds: List<String>): SentientResult<ScheduledSessionCardsClearResponse> {
        val targets = occurrenceIds.toList()
        if (targets.isEmpty()) return SentientResult.Success(ScheduledSessionCardsClearResponse(true))
        return cardOperations.withLock {
            if (closed) return@withLock SentientResult.Loading()
            val operation = generation
            val result = repository.clearCards(targets)
            if (result is SentientResult.Success && isCurrent(operation)) {
                val cleared = targets.toSet()
                _cards.value = SentientResult.Success(currentCards().filterNot { it.occurrenceId in cleared })
                loadCards(operation, PAGE_SIZE)
            }
            result
        }
    }

    /** Legacy fire-and-forget selection path. Native inbox uses acknowledged activation instead. */
    fun select(card: ScheduledSessionCard) { selectSession(card.sessionId) }

    fun close() {
        closed = true
        generation += 1
        _schedules.value = SentientResult.Loading()
        _cards.value = SentientResult.Loading()
    }

    private suspend fun <T : Any> mutateSchedule(operation: suspend () -> SentientResult<T>): SentientResult<T> =
        scheduleOperations.withLock {
            if (closed) return@withLock SentientResult.Loading()
            val fence = generation
            val result = operation()
            if (isCurrent(fence)) loadSchedules(fence, PAGE_SIZE)
            result
        }

    private suspend fun loadSchedules(operation: Long, limit: Int): SentientResult<List<Schedule>> {
        require(limit in 1..PAGE_SIZE)
        if (isCurrent(operation)) _schedules.value = SentientResult.Loading(currentSchedules())
        val result = repository.list(limit = limit).map { it.schedules }
        if (isCurrent(operation)) _schedules.value = result
        return result
    }

    private suspend fun loadCards(operation: Long, limit: Int): SentientResult<List<ScheduledSessionCard>> {
        if (isCurrent(operation)) _cards.value = SentientResult.Loading(currentCards())
        val cards = linkedMapOf<String, ScheduledSessionCard>()
        val cursors = mutableSetOf<String>()
        var cursor: String? = null
        var pageCount = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            if (++pageCount > MAX_INBOX_PAGES) return invalidCardPage(operation)
            val page = when (val result = repository.cards(cursor, limit)) {
                is SentientResult.Success -> result.data
                is SentientResult.Failure -> return result.also { if (isCurrent(operation)) _cards.value = it }
                is SentientResult.Loading -> return SentientResult.Loading(cards.values.toList()).also { if (isCurrent(operation)) _cards.value = it }
            }
            if (!isCurrent(operation)) return SentientResult.Loading()
            val previousSize = cards.size
            // Offset pages are weak snapshots: overlap is deduped, while external-delete omissions reconcile on Reload.
            page.cards.forEach { card -> cards.getOrPut(card.occurrenceId) { card } }
            val next = page.nextCursor
            if (cards.size > MAX_INBOX_CARDS ||
                next != null && (cards.size >= MAX_INBOX_CARDS || cards.size == previousSize || !cursors.add(next))
            ) return invalidCardPage(operation)
            if (next == null) {
                return SentientResult.Success(cards.values.toList()).also { if (isCurrent(operation)) _cards.value = it }
            }
            cursor = next
        }
    }

    private fun invalidCardPage(operation: Long) =
        SentientResult.Failure(SentientError.Protocol("The server returned an invalid scheduled message page."))
            .also { if (isCurrent(operation)) _cards.value = it }

    private fun currentSchedules() = when (val value = _schedules.value) {
        is SentientResult.Success -> value.data
        is SentientResult.Loading -> value.partial
        is SentientResult.Failure -> null
    }

    private fun currentCards() = when (val value = _cards.value) {
        is SentientResult.Success -> value.data
        is SentientResult.Loading -> value.partial.orEmpty()
        is SentientResult.Failure -> emptyList()
    }

    private fun isCurrent(operation: Long) = !closed && generation == operation
}

private inline fun <T : Any, R : Any> SentientResult<T>.map(transform: (T) -> R): SentientResult<R> = when (this) {
    is SentientResult.Success -> SentientResult.Success(transform(data))
    is SentientResult.Failure -> this
    is SentientResult.Loading -> SentientResult.Loading(partial?.let(transform))
}
