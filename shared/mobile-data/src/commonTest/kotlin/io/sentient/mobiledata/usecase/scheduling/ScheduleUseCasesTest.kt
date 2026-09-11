package io.sentient.mobiledata.usecase.scheduling

import io.sentient.mobiledata.data.scheduling.ScheduleRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
import io.sentient.mobilesdk.scheduling.*
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
}

private class FakeScheduleRepository(private val schedule: Schedule) : ScheduleRepository {
    var listCalls = 0
    override suspend fun create(request: ScheduleCreateRequest) = error("unused")
    override suspend fun list(cursor: String?, limit: Int?): SentientResult<ScheduleListResponse> {
        listCalls++; return SentientResult.Success(ScheduleListResponse(listOf(schedule)))
    }
    override suspend fun patch(scheduleId: String, request: SchedulePatchRequest): SentientResult<SchedulePatchResponse> =
        SentientResult.Failure(SentientError.Protocol("conflict"))
    override suspend fun delete(scheduleId: String, expectedRevision: Int) = error("unused")
    override suspend fun cards(cursor: String?, limit: Int?) = error("unused")
}
private fun sampleSchedule() = Schedule("schedule-1", 1, "hello", ScheduleTiming.Once("2026-08-01T15:30:00Z"), true, ScheduleSource.User, "2026-08-01T15:30:00Z", "2026-08-01T15:00:00Z", "2026-08-01T15:00:00Z")
private fun sampleCard() = ScheduledSessionCard("session-1", "schedule-1", "occ-1", "2026-08-01T15:30:00Z", "2026-08-01T15:31:00Z", ScheduledSessionStatus.COMPLETED, "Done")
