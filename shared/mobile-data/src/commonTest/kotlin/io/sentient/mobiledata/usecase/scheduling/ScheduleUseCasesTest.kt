package io.sentient.mobiledata.usecase.scheduling

import io.sentient.mobiledata.data.scheduling.ScheduleRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.scheduling.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ScheduleUseCasesTest {
    @Test fun failedMutationReloadsAuthoritativeStateAndCardUsesExistingResume() = runTest {
        val schedule = sampleSchedule()
        val repo = FakeScheduleRepository(schedule)
        var selected: String? = null
        val useCases = ScheduleUseCases(repo) { selected = it }
        useCases.reload()
        val failed = useCases.pause(schedule)
        assertIs<SentientResult.Failure>(failed)
        assertEquals(2, repo.listCalls)
        assertEquals(listOf(schedule), assertIs<SentientResult.Success<List<Schedule>>>(useCases.schedules.value).data)
        useCases.select(sampleCard())
        assertEquals("session-1", selected)
        useCases.close()
        assertIs<SentientResult.Loading<List<Schedule>>>(useCases.schedules.value)
    }

    @Test fun loadCardsAcceptsMoreThanDefaultOperatorCap() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule()).withCardCount(501)

        val result = assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(ScheduleUseCases(repo).loadCards())

        assertEquals(501, result.data.size)
        assertEquals(6, repo.cardCursors.size)
    }

    @Test fun loadCardsAcceptsSupportedOperatorUpperBound() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule()).withCardCount(10_000)

        val result = assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(ScheduleUseCases(repo).loadCards())

        assertEquals(10_000, result.data.size)
        assertEquals(100, repo.cardCursors.size)
    }

    @Test fun loadCardsRejectsEmptyRepeatedAndDuplicateOnlyProgressPages() = runTest {
        suspend fun assertInvalid(vararg pages: ScheduledSessionCardPage) {
            val repo = FakeScheduleRepository(sampleSchedule())
            var index = 0
            repo.cardsResult = { _, _ -> SentientResult.Success(pages[index++]) }
            assertIs<SentientResult.Failure>(ScheduleUseCases(repo).loadCards())
        }

        assertInvalid(ScheduledSessionCardPage(emptyList(), "fresh-cursor"))
        assertInvalid(
            ScheduledSessionCardPage(listOf(sampleCard("one")), "repeat"),
            ScheduledSessionCardPage(listOf(sampleCard("two")), "repeat"),
        )
        assertInvalid(
            ScheduledSessionCardPage(listOf(sampleCard("one")), "next"),
            ScheduledSessionCardPage(listOf(sampleCard("one")), "another"),
        )
    }

    @Test fun loadCardsDeduplicatesOffsetPageOverlap() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule())
        val pages = mapOf(
            null to ScheduledSessionCardPage(listOf(sampleCard("one"), sampleCard("two")), "next"),
            "next" to ScheduledSessionCardPage(listOf(sampleCard("two"), sampleCard("three"))),
        )
        repo.cardsResult = { cursor, _ -> SentientResult.Success(pages.getValue(cursor)) }

        val result = assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(ScheduleUseCases(repo).loadCards())

        assertEquals(listOf("occ-one", "occ-two", "occ-three"), result.data.map { it.occurrenceId })
    }

    @Test fun acknowledgedSingleClearRestartsPagingAndKeepsLaterArrivals() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule())
        var afterClear = false
        repo.cardsResult = { cursor, _ ->
            assertNull(cursor)
            SentientResult.Success(ScheduledSessionCardPage(if (afterClear) listOf(sampleCard("later")) else listOf(sampleCard())))
        }
        repo.clearCardResult = {
            assertEquals("session-1", it)
            afterClear = true
            SentientResult.Success(ScheduledSessionCardsClearResponse(true))
        }
        val useCases = ScheduleUseCases(repo)
        useCases.loadCards()

        assertIs<SentientResult.Success<ScheduledSessionCardsClearResponse>>(useCases.clearCard("session-1"))

        assertEquals(listOf("later"), assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(useCases.cards.value).data.map { it.sessionId })
        assertEquals(listOf<String?>(null, null), repo.cardCursors)
    }

    @Test fun committedBulkDeleteWithLostResponseReconcilesWithoutImplicitRetry() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule())
        var serverCards = listOf(sampleCard("old"))
        repo.cardsResult = { _, _ -> SentientResult.Success(ScheduledSessionCardPage(serverCards)) }
        repo.clearCardsResult = { targets ->
            assertEquals(listOf("occ-old"), targets)
            serverCards = emptyList()
            SentientResult.Failure(SentientError.Connection("unknown outcome"))
        }
        val useCases = ScheduleUseCases(repo)
        useCases.loadCards()

        assertIs<SentientResult.Failure>(useCases.clearCards())
        serverCards = listOf(sampleCard("later"))
        useCases.loadCards()

        assertEquals(1, repo.clearCardsCalls)
        assertEquals("later", assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(useCases.cards.value).data.single().sessionId)
    }

    @Test fun explicitlyReconfirmedBulkRetryIssuesNewDelete() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule())
        repo.cardsResult = { _, _ -> SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("old")))) }
        repo.clearCardsResult = { SentientResult.Failure(SentientError.Connection("unknown outcome")) }
        val useCases = ScheduleUseCases(repo)
        useCases.loadCards()
        val frozenTargets = listOf("occ-old")
        assertIs<SentientResult.Failure>(useCases.clearCards(frozenTargets))

        repo.clearCardsResult = { SentientResult.Success(ScheduledSessionCardsClearResponse(true)) }
        assertIs<SentientResult.Success<ScheduledSessionCardsClearResponse>>(useCases.clearCards(frozenTargets))

        assertEquals(listOf(frozenTargets, frozenTargets), repo.clearCardsTargets)
    }

    @Test fun acknowledgedBulkClearRemovesOnlyTargetsBeforeAuthoritativeRefresh() = runTest {
        val refresh = CompletableDeferred<Unit>()
        val repo = FakeScheduleRepository(sampleSchedule())
        var calls = 0
        repo.cardsResult = { _, _ ->
            if (calls++ == 0) SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("old"), sampleCard("incoming"))))
            else {
                refresh.await()
                SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("incoming"), sampleCard("new"))))
            }
        }
        repo.clearCardsResult = { SentientResult.Success(ScheduledSessionCardsClearResponse(true)) }
        val useCases = ScheduleUseCases(repo)
        useCases.loadCards()

        val clear = async { useCases.clearCards(listOf("occ-old")) }
        runCurrent()
        assertEquals(listOf("incoming"), assertIs<SentientResult.Loading<List<ScheduledSessionCard>>>(useCases.cards.value).partial?.map { it.sessionId })
        refresh.complete(Unit)
        clear.await()

        assertEquals(listOf("incoming", "new"), assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(useCases.cards.value).data.map { it.sessionId })
    }

    @Test fun bulkClearFreezesCurrentTargetsBeforeWaitingForCardMutex() = runTest {
        val release = CompletableDeferred<Unit>()
        val repo = FakeScheduleRepository(sampleSchedule())
        var calls = 0
        repo.cardsResult = { _, _ -> when (calls++) {
            0 -> SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("old"))))
            1 -> { release.await(); SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("old"), sampleCard("incoming")))) }
            else -> SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("incoming"))))
        } }
        repo.clearCardsResult = { SentientResult.Success(ScheduledSessionCardsClearResponse(true)) }
        val useCases = ScheduleUseCases(repo)
        useCases.loadCards()
        val reload = async { useCases.loadCards() }
        runCurrent()

        val clear = async { useCases.clearCards() }
        runCurrent()
        release.complete(Unit)
        reload.await()
        clear.await()

        assertEquals(listOf(listOf("occ-old")), repo.clearCardsTargets)
        assertEquals(listOf("incoming"), assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(useCases.cards.value).data.map { it.sessionId })
    }

    @Test fun emptyBulkTargetsAreLocalNoOp() = runTest {
        val repo = FakeScheduleRepository(sampleSchedule())
        val useCases = ScheduleUseCases(repo)

        assertIs<SentientResult.Success<ScheduledSessionCardsClearResponse>>(useCases.clearCards(emptyList()))
        assertEquals(0, repo.clearCardsCalls)
        assertIs<SentientResult.Loading<List<ScheduledSessionCard>>>(useCases.cards.value)
    }

    @Test fun cancelledCardLoadReleasesOperationMutex() = runTest {
        val release = CompletableDeferred<Unit>()
        val repo = FakeScheduleRepository(sampleSchedule())
        repo.cardsResult = { _, _ -> release.await(); error("cancelled request continued") }
        val useCases = ScheduleUseCases(repo)
        val load = async { useCases.loadCards() }
        runCurrent()

        load.cancelAndJoin()
        repo.cardsResult = { _, _ -> SentientResult.Success(ScheduledSessionCardPage(emptyList())) }

        assertIs<SentientResult.Success<List<ScheduledSessionCard>>>(useCases.loadCards())
    }

    @Test fun closeFencesDelayedCardResponse() = runTest {
        val release = CompletableDeferred<Unit>()
        val repo = FakeScheduleRepository(sampleSchedule())
        repo.cardsResult = { _, _ ->
            release.await()
            SentientResult.Success(ScheduledSessionCardPage(listOf(sampleCard("late"))))
        }
        val useCases = ScheduleUseCases(repo)
        val load = async { useCases.loadCards() }
        runCurrent()

        useCases.close()
        release.complete(Unit)
        load.await()

        assertNull(assertIs<SentientResult.Loading<List<ScheduledSessionCard>>>(useCases.cards.value).partial)
    }
}

private fun FakeScheduleRepository.withCardCount(total: Int) = apply {
    cardsResult = { cursor, limit ->
        val start = cursor?.toInt() ?: 0
        val end = minOf(start + (limit ?: 100), total)
        SentientResult.Success(ScheduledSessionCardPage(
            cards = (start until end).map { sampleCard("session-$it") },
            nextCursor = end.takeIf { it < total }?.toString(),
        ))
    }
}

private class FakeScheduleRepository(private val schedule: Schedule) : ScheduleRepository {
    var listCalls = 0
    val cardCursors = mutableListOf<String?>()
    var clearCardsCalls = 0
    val clearCardsTargets = mutableListOf<List<String>>()
    var cardsResult: suspend (String?, Int?) -> SentientResult<ScheduledSessionCardPage> = { _, _ -> error("unused") }
    var clearCardResult: suspend (String) -> SentientResult<ScheduledSessionCardsClearResponse> = { error("unused") }
    var clearCardsResult: suspend (List<String>) -> SentientResult<ScheduledSessionCardsClearResponse> = { error("unused") }

    override suspend fun create(request: ScheduleCreateRequest) = error("unused")
    override suspend fun list(cursor: String?, limit: Int?): SentientResult<ScheduleListResponse> {
        listCalls++
        return SentientResult.Success(ScheduleListResponse(listOf(schedule)))
    }
    override suspend fun patch(scheduleId: String, request: SchedulePatchRequest): SentientResult<SchedulePatchResponse> =
        SentientResult.Failure(SentientError.Protocol("conflict"))
    override suspend fun delete(scheduleId: String, expectedRevision: Int) = error("unused")
    override suspend fun cards(cursor: String?, limit: Int?): SentientResult<ScheduledSessionCardPage> {
        cardCursors += cursor
        return cardsResult(cursor, limit)
    }
    override suspend fun clearCard(sessionId: String) = clearCardResult(sessionId)
    override suspend fun clearCards(occurrenceIds: List<String>): SentientResult<ScheduledSessionCardsClearResponse> {
        clearCardsCalls++
        clearCardsTargets += occurrenceIds
        return clearCardsResult(occurrenceIds)
    }
}

private fun sampleSchedule() = Schedule("schedule-1", 1, "hello", ScheduleTiming.Once("2026-08-01T15:30:00Z"), true, ScheduleSource.User, "2026-08-01T15:30:00Z", "2026-08-01T15:00:00Z", "2026-08-01T15:00:00Z")
private fun sampleCard(sessionId: String = "session-1") = ScheduledSessionCard(sessionId, "schedule-1", "occ-$sessionId", "2026-08-01T15:30:00Z", "2026-08-01T15:31:00Z", ScheduledSessionStatus.COMPLETED, "Done")
