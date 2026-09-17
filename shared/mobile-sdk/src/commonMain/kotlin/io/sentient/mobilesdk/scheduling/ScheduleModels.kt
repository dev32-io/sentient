package io.sentient.mobilesdk.scheduling

import kotlinx.datetime.TimeZone
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlin.time.Instant

const val SCHEDULES_ROUTE = "/api/v1/schedules"
const val SCHEDULE_CARDS_ROUTE = "/api/v1/scheduled-session-cards"

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ScheduleTimingInput {
    @Serializable @SerialName("once-at")
    data class OnceAt(val at: String) : ScheduleTimingInput()

    @Serializable @SerialName("once-after")
    data class OnceAfter(val afterSeconds: Int) : ScheduleTimingInput()

    @Serializable @SerialName("recurring")
    data class Recurring(
        val frequency: ScheduleFrequency,
        val localTime: String,
        val timeZone: String,
        val weekdays: List<ScheduleWeekday>? = null,
        val dayOfMonth: Int? = null,
    ) : ScheduleTimingInput()
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ScheduleTiming {
    @Serializable @SerialName("once")
    data class Once(val at: String) : ScheduleTiming()

    @Serializable @SerialName("recurring")
    data class Recurring(
        val frequency: ScheduleFrequency,
        val localTime: String,
        val timeZone: String,
        val weekdays: List<ScheduleWeekday>? = null,
        val dayOfMonth: Int? = null,
    ) : ScheduleTiming()
}

@Serializable enum class ScheduleFrequency { @SerialName("daily") DAILY, @SerialName("weekly") WEEKLY, @SerialName("monthly") MONTHLY }
@Serializable enum class ScheduleWeekday {
    @SerialName("monday") MONDAY, @SerialName("tuesday") TUESDAY, @SerialName("wednesday") WEDNESDAY,
    @SerialName("thursday") THURSDAY, @SerialName("friday") FRIDAY, @SerialName("saturday") SATURDAY,
    @SerialName("sunday") SUNDAY,
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ScheduleSource {
    @Serializable @SerialName("user") data object User : ScheduleSource()
    @Serializable @SerialName("calendar-reminder")
    data class CalendarReminder(val eventId: String, val reminderId: String) : ScheduleSource()
}

@Serializable
data class Schedule(
    val scheduleId: String,
    val revision: Int,
    val message: String,
    val timing: ScheduleTiming,
    val enabled: Boolean,
    val source: ScheduleSource,
    val nextRunAt: String?,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable data class ScheduleCreateRequest(
    val idempotencyKey: String,
    val message: String,
    val timing: ScheduleTimingInput,
    val enabled: Boolean = true,
)
@Serializable data class ScheduleCreateResponse(val schedule: Schedule, val replayed: Boolean)
@Serializable data class ScheduleChanges(val message: String? = null, val timing: ScheduleTimingInput? = null, val enabled: Boolean? = null)
@Serializable data class SchedulePatchRequest(val expectedRevision: Int, val changes: ScheduleChanges)
@Serializable data class SchedulePatchResponse(val schedule: Schedule)
@Serializable data class ScheduleDeleteRequest(val expectedRevision: Int)
@Serializable data class ScheduleDeleteResponse(val scheduleId: String, val deleted: Boolean)
@Serializable data class ScheduleListResponse(val schedules: List<Schedule>, val nextCursor: String? = null)

@Serializable enum class ScheduledSessionStatus { @SerialName("completed") COMPLETED, @SerialName("failed") FAILED, @SerialName("interrupted") INTERRUPTED }
@Serializable data class ScheduledSessionCard(
    val sessionId: String,
    val scheduleId: String,
    val occurrenceId: String,
    val intendedAt: String,
    val completedAt: String,
    val status: ScheduledSessionStatus,
    val preview: String? = null,
)
@Serializable data class ScheduledSessionCardPage(val cards: List<ScheduledSessionCard>, val nextCursor: String? = null)
@Serializable data class ScheduledSessionCardsClearRequest(val occurrenceIds: List<String>)
@Serializable data class ScheduledSessionCardsClearResponse(val cleared: Boolean)

internal fun ScheduleCreateRequest.validate() {
    require(idempotencyKey.isNotBlank() && idempotencyKey.length <= 200)
    require(message.isNotBlank() && message.length <= 12_000)
    timing.validate()
}
internal fun SchedulePatchRequest.validate() {
    require(expectedRevision > 0)
    require(changes.message != null || changes.timing != null || changes.enabled != null)
    changes.message?.let { require(it.isNotBlank() && it.length <= 12_000) }
    changes.timing?.validate()
}
internal fun ScheduleTimingInput.validate() = when (this) {
    is ScheduleTimingInput.OnceAt -> require(at.isWireInstant())
    is ScheduleTimingInput.OnceAfter -> require(afterSeconds in 1..31_536_000)
    is ScheduleTimingInput.Recurring -> validateRecurrence(frequency, localTime, timeZone, weekdays, dayOfMonth)
}
internal fun Schedule.validate() {
    require(scheduleId.isNotBlank() && revision > 0 && message.isNotBlank() && message.length <= 12_000)
    require(createdAt.isWireInstant() && updatedAt.isWireInstant() && (nextRunAt == null || nextRunAt.isWireInstant()))
    when (val value = timing) {
        is ScheduleTiming.Once -> require(value.at.isWireInstant())
        is ScheduleTiming.Recurring -> validateRecurrence(value.frequency, value.localTime, value.timeZone, value.weekdays, value.dayOfMonth)
    }
    when (val value = source) {
        ScheduleSource.User -> Unit
        is ScheduleSource.CalendarReminder -> require(value.eventId.isNotBlank() && value.reminderId.isNotBlank())
    }
}
internal fun ScheduledSessionCard.validate() {
    require(sessionId.isNotBlank() && scheduleId.isNotBlank() && occurrenceId.isNotBlank())
    require(intendedAt.isWireInstant() && completedAt.isWireInstant())
    require(if (status == ScheduledSessionStatus.COMPLETED) !preview.isNullOrBlank() && preview.length <= 280 else preview == null)
}
internal fun ScheduledSessionCardsClearRequest.validate() {
    require(occurrenceIds.size in 1..10_000)
    require(occurrenceIds.all(String::isNotEmpty) && occurrenceIds.distinct().size == occurrenceIds.size)
}
internal fun ScheduledSessionCardsClearResponse.validate() { require(cleared) }
private fun validateRecurrence(frequency: ScheduleFrequency, localTime: String, timeZone: String, weekdays: List<ScheduleWeekday>?, dayOfMonth: Int?) {
    require(Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$").matches(localTime) && timeZone.isNotBlank() && timeZone.length <= 128)
    TimeZone.of(timeZone)
    require((frequency == ScheduleFrequency.WEEKLY) == (weekdays != null))
    require((frequency == ScheduleFrequency.MONTHLY) == (dayOfMonth != null))
    weekdays?.let { require(it.isNotEmpty() && it.size <= 7 && it.distinct().size == it.size) }
    dayOfMonth?.let { require(it in 1..31) }
}
internal fun String.isWireInstant(): Boolean =
    Regex("^\\d{4}-\\d{2}-\\d{2}T.+(?:Z|[+-]\\d{2}:\\d{2})$").matches(this) && runCatching { Instant.parse(this) }.isSuccess
