package io.sentient.mobiledata.data.scheduling

import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.scheduling.*

/** Stateless scheduling transport boundary. Pagination and UI state stay in usecases. */
interface ScheduleRepository {
    suspend fun create(request: ScheduleCreateRequest): SentientResult<ScheduleCreateResponse>
    suspend fun list(cursor: String? = null, limit: Int? = null): SentientResult<ScheduleListResponse>
    suspend fun patch(scheduleId: String, request: SchedulePatchRequest): SentientResult<SchedulePatchResponse>
    suspend fun delete(scheduleId: String, expectedRevision: Int): SentientResult<ScheduleDeleteResponse>
    suspend fun cards(cursor: String? = null, limit: Int? = null): SentientResult<ScheduledSessionCardPage>
}

class SdkScheduleRepository(private val client: ScheduleHttpClient) : ScheduleRepository {
    override suspend fun create(request: ScheduleCreateRequest) = client.create(request).toScheduleResult()
    override suspend fun list(cursor: String?, limit: Int?) = client.list(cursor, limit).toScheduleResult()
    override suspend fun patch(scheduleId: String, request: SchedulePatchRequest) = client.patch(scheduleId, request).toScheduleResult()
    override suspend fun delete(scheduleId: String, expectedRevision: Int) = client.delete(scheduleId, expectedRevision).toScheduleResult()
    override suspend fun cards(cursor: String?, limit: Int?) = client.cards(cursor, limit).toScheduleResult()
}
