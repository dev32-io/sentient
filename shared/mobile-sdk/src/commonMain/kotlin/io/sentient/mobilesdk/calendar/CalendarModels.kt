@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package io.sentient.mobilesdk.calendar

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonClassDiscriminator

/** A UTC instant paired with the event's IANA (or gateway) time-zone id. */
@Serializable
data class TimedValue(val kind: String = "timed", val instant: String, val timeZoneId: String)

/** A date without a time or time-zone. */
@Serializable
data class AllDayValue(val kind: String = "all-day", val date: String)

@Serializable
@JsonClassDiscriminator("kind")
sealed class CalendarTime {
    @Serializable
    @SerialName("timed")
    data class Timed(val instant: String, val timeZoneId: String) : CalendarTime()

    @Serializable
    @SerialName("all-day")
    data class AllDay(val date: String) : CalendarTime()
}

@Serializable
enum class Visibility { @SerialName("everyone") EVERYONE, @SerialName("adults") ADULTS }

@Serializable
enum class Importance {
    @SerialName("normal") NORMAL,
    @SerialName("important") IMPORTANT,
    @SerialName("pinned") PINNED,
}

@Serializable
enum class CalendarScope { @SerialName("private") PRIVATE, @SerialName("household") HOUSEHOLD }

typealias Group = String
typealias Tags = List<String>

typealias CalendarEventId = String
typealias UtcInstant = String

typealias LocalDate = String

@Serializable
enum class RRuleFrequency { DAILY, WEEKLY, MONTHLY, YEARLY }

@Serializable
data class RRule(
    val freq: RRuleFrequency,
    val interval: Int? = null,
    val count: Int? = null,
    val until: String? = null,
    val byDay: List<String>? = null,
)

@Serializable
data class Recurrence(val rrule: String, val rule: RRule)

@Serializable
data class ExceptionOverride(
    val occurrence: CalendarTime,
    val cancelled: Boolean? = null,
    val title: String? = null,
    val start: CalendarTime? = null,
    val end: CalendarTime? = null,
)

@Serializable
data class CalendarEvent(
    val id: String,
    val scope: CalendarScope,
    val title: String,
    val description: String? = null,
    val start: CalendarTime,
    val end: CalendarTime? = null,
    val recurrence: Recurrence? = null,
    val exdates: List<CalendarTime>? = null,
    val exceptions: List<ExceptionOverride>? = null,
    val visibility: Visibility,
    val importance: Importance,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    @SerialName("notificationPolicy") val notification: JsonObject? = null,
    val createdAt: String,
    val updatedAt: String,
)

/** Occurrence-only fields are used by local consumers when expanding a recurring event. */
@Serializable
data class Occurrence(
    val occurrenceId: String,
    val baseEventId: String,
    val occurrenceStart: CalendarTime,
    val occurrenceEnd: CalendarTime? = null,
    val event: CalendarEvent,
)

@Serializable
data class CalendarEventPage(val events: List<CalendarEvent>, val more: Int)

@Serializable
data class CalendarResponse<T>(val version: Int, val requestId: String, val body: T)

/** Convenience aliases retained as descriptive names for repository consumers. */
typealias CalendarList = CalendarEventPage
