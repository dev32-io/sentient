package io.sentient.mobilesdk.calendar

import kotlinx.datetime.TimeZone
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Source-level time convenience retained for existing mobile callers.  REST V2
 * uses the raw RFC3339/date spelling (see [CalendarTime.toWireValue]); this
 * type is never used as a query or request-body serializer.
 */
sealed class CalendarTime {
    data class Timed(val instant: String, val timeZoneId: String) : CalendarTime()
    data class AllDay(val date: String) : CalendarTime()

    fun toWireValue(): String = when (this) {
        is Timed -> instant
        is AllDay -> date
    }
}

/** Explicit marker used when a V2 raw temporal value has no IANA zone field. */
const val CALENDAR_WIRE_TIME_ZONE = "wire"

fun String.toCalendarTime(): CalendarTime =
    if (matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))) CalendarTime.AllDay(this)
    else CalendarTime.Timed(this, CALENDAR_WIRE_TIME_ZONE)

@Serializable
enum class Visibility {
    @SerialName("everyone") EVERYONE,
    @SerialName("adults") ADULTS,
}

@Serializable
enum class Importance {
    @SerialName("normal") NORMAL,
    @SerialName("important") IMPORTANT,
    @SerialName("pinned") PINNED,
}

@Serializable
enum class CalendarScope {
    @SerialName("private") PRIVATE,
    @SerialName("household") HOUSEHOLD,
    @SerialName("all") ALL,
}

typealias CalendarReadScope = CalendarScope
typealias Group = String
typealias Tags = List<String>
typealias CalendarEventId = String
typealias UtcInstant = String
typealias LocalDate = String
typealias CalendarRevision = Int

@Serializable
enum class CalendarReminderMode {
    @SerialName("at-start") AT_START,
    @SerialName("lead") LEAD,
    @SerialName("all-day") ALL_DAY,
}

/** Personal reminder input; enabled=false is the explicit update removal form. */
@Serializable
data class CalendarReminderInput(
    val enabled: Boolean,
    val mode: CalendarReminderMode? = null,
    val leadMinutes: Int? = null,
    val localTime: String? = null,
    val timeZone: String? = null,
)

@Serializable
data class CalendarReminderOutput(
    val reminderId: String? = null,
    val enabled: Boolean,
    val mode: CalendarReminderMode? = null,
    val leadMinutes: Int? = null,
    val localTime: String? = null,
    val timeZone: String? = null,
)

internal fun CalendarReminderInput.validate(start: String? = null, create: Boolean = false) {
    if (!enabled) {
        require(!create && mode == null && leadMinutes == null && localTime == null && timeZone == null)
        return
    }
    requireNotNull(mode)
    require((mode == CalendarReminderMode.LEAD) == (leadMinutes != null))
    leadMinutes?.let { require(it in 1..43_200) }
    require((mode == CalendarReminderMode.ALL_DAY) == (localTime != null && timeZone != null))
    localTime?.let { require(Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$").matches(it)) }
    timeZone?.let { require(it.isNotBlank()); TimeZone.of(it) }
    start?.let { require(it.contains('T') != (mode == CalendarReminderMode.ALL_DAY)) }
}

internal fun CalendarReminderOutput.validate() {
    if (!enabled) {
        require(reminderId == null && mode == null && leadMinutes == null && localTime == null && timeZone == null)
    } else {
        require(!reminderId.isNullOrBlank())
        CalendarReminderInput(true, mode, leadMinutes, localTime, timeZone).validate()
    }
}

@Serializable
enum class RecurrenceFrequency {
    @SerialName("daily") DAILY,
    @SerialName("weekly") WEEKLY,
    @SerialName("monthly") MONTHLY,
    @SerialName("yearly") YEARLY,
}

@Serializable
enum class Weekday {
    @SerialName("monday") MONDAY,
    @SerialName("tuesday") TUESDAY,
    @SerialName("wednesday") WEDNESDAY,
    @SerialName("thursday") THURSDAY,
    @SerialName("friday") FRIDAY,
    @SerialName("saturday") SATURDAY,
    @SerialName("sunday") SUNDAY,
}

/** Structured recurrence used by every V2 create/update wire shape. */
@Serializable
data class StructuredRecurrence(
    val frequency: RecurrenceFrequency,
    val interval: Int? = null,
    val weekdays: List<Weekday>? = null,
    val count: Int? = null,
    val until: String? = null,
)

typealias RecurrenceInput = StructuredRecurrence
typealias CalendarRecurrence = StructuredRecurrence

/** Exact V2 create input. Server-owned identity, revision, and timestamps are absent. */
@Serializable
data class CalendarCreateInput(
    val scope: CalendarScope? = null,
    val title: String,
    val description: String? = null,
    val start: String,
    val end: String? = null,
    val visibility: Visibility = Visibility.EVERYONE,
    val importance: Importance = Importance.NORMAL,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    val recurrence: StructuredRecurrence? = null,
    @SerialName("notificationPolicy") val notificationPolicy: JsonObject? = null,
    val reminder: CalendarReminderInput? = null,
)

/** Exact V2 persisted event projection (get/create response body). */
@Serializable
data class CalendarEventV2(
    val eventId: String,
    val revision: Int,
    val scope: CalendarScope,
    val title: String,
    val description: String? = null,
    val start: String,
    val end: String? = null,
    val visibility: Visibility,
    val importance: Importance,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    val recurrence: StructuredRecurrence? = null,
    val reminder: CalendarReminderOutput? = null,
)

/** Exact V2 effective occurrence projection (list and occurrence get response body). */
@Serializable
data class EffectiveOccurrence(
    val eventId: String,
    val occurrenceId: String,
    val originalStart: String,
    val recurring: Boolean,
    val revision: Int,
    val scope: CalendarScope,
    val title: String,
    val description: String? = null,
    val start: String,
    val end: String? = null,
    val visibility: Visibility,
    val importance: Importance,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    val recurrence: StructuredRecurrence? = null,
    val reminder: CalendarReminderOutput? = null,
)

/** Exact V2 bounded page returned by list. */
@Serializable
data class CalendarPage(
    val events: List<EffectiveOccurrence>,
    val nextCursor: String? = null,
)

typealias CalendarQueryPage = CalendarPage

/**
 * Source-facing page adapter. V2 pagination is represented only by [nextCursor].
 * The unused constructor parameter preserves positional source compatibility for
 * existing platform callers without retaining a V1 page field.
 */
class CalendarEventPage(
    val events: List<CalendarEvent>,
    @Suppress("UNUSED_PARAMETER") more: Int = 0,
    val nextCursor: String? = null,
)

typealias CalendarList = CalendarEventPage

typealias CalendarOccurrence = EffectiveOccurrence

/** Source-only legacy convenience for callers that keep local exception state. */
data class ExceptionOverride(
    val occurrence: CalendarTime,
    val cancelled: Boolean? = null,
    val title: String? = null,
    val start: CalendarTime? = null,
    val end: CalendarTime? = null,
)

@Serializable
enum class CalendarMutationScope(val wire: String) {
    @SerialName("this_occurrence") THIS_OCCURRENCE("this_occurrence"),
    @SerialName("this_and_following") THIS_AND_FOLLOWING("this_and_following"),
    @SerialName("entire_series") ENTIRE_SERIES("entire_series"),
}

@Serializable
enum class CalendarOperation(val wire: String) {
    @SerialName("update") UPDATE("update"),
    @SerialName("delete") DELETE("delete"),
}

/**
 * A patch value has an explicit wire-presence state. This is deliberately not
 * represented by nullable Kotlin properties: the shared request Json uses
 * explicitNulls=false, so a nullable property cannot express a JSON null.
 */
sealed interface CalendarPatch<out T> {
    data object Unchanged : CalendarPatch<Nothing>
    data class Value<T>(val value: T) : CalendarPatch<T>
    data object Clear : CalendarPatch<Nothing>
}

/**
 * Allowlisted V2 update fields. Nullable-clearable fields use [CalendarPatch]
 * so omission, replacement, and an explicit JSON null remain distinct.
 * Empty [tags] is the explicit tag-clear operation; null tags means omitted.
 */
@Serializable(with = CalendarChangesSerializer::class)
data class CalendarChanges(
    val title: String? = null,
    val description: CalendarPatch<String> = CalendarPatch.Unchanged,
    val start: String? = null,
    val end: CalendarPatch<String> = CalendarPatch.Unchanged,
    val visibility: Visibility? = null,
    val importance: Importance? = null,
    val group: CalendarPatch<String> = CalendarPatch.Unchanged,
    val tags: List<String>? = null,
    val recurrence: CalendarPatch<StructuredRecurrence> = CalendarPatch.Unchanged,
    /** Null means omitted/preserve; enabled=false explicitly removes the personal reminder. */
    val reminder: CalendarReminderInput? = null,
)

/**
 * Custom JSON encoding is required because Json{ explicitNulls = false } would
 * otherwise remove even an intentionally encoded null. The JsonEncoder branch
 * writes the complete object directly, preserving only explicit clears.
 */
@OptIn(ExperimentalSerializationApi::class)
internal object CalendarChangesSerializer : KSerializer<CalendarChanges> {
    private val recurrenceSerializer = StructuredRecurrence.serializer()
    private val tagsSerializer = ListSerializer(String.serializer())
    private val patchJson = Json {
        encodeDefaults = false
        explicitNulls = false
    }

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("CalendarChanges") {
        element<String>("title", isOptional = true)
        element<String?>("description", isOptional = true)
        element<String>("start", isOptional = true)
        element<String?>("end", isOptional = true)
        element<Visibility>("visibility", isOptional = true)
        element<Importance>("importance", isOptional = true)
        element<String?>("group", isOptional = true)
        element<List<String>?>("tags", isOptional = true)
        element<StructuredRecurrence?>("recurrence", isOptional = true)
        element<CalendarReminderInput>("reminder", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: CalendarChanges) {
        if (encoder is JsonEncoder) {
            encoder.encodeJsonElement(value.toJson())
            return
        }
        encoder.encodeStructure(descriptor) {
            value.title?.let { encodeStringElement(descriptor, 0, it) }
            encodePatch(1, value.description, String.serializer())
            value.start?.let { encodeStringElement(descriptor, 2, it) }
            encodePatch(3, value.end, String.serializer())
            value.visibility?.let { encodeSerializableElement(descriptor, 4, Visibility.serializer(), it) }
            value.importance?.let { encodeSerializableElement(descriptor, 5, Importance.serializer(), it) }
            encodePatch(6, value.group, String.serializer())
            value.tags?.let { encodeSerializableElement(descriptor, 7, tagsSerializer, it) }
            encodePatch(8, value.recurrence, recurrenceSerializer)
            value.reminder?.let { encodeSerializableElement(descriptor, 9, CalendarReminderInput.serializer(), it) }
        }
    }

    override fun deserialize(decoder: Decoder): CalendarChanges = decoder.decodeStructure(descriptor) {
        var title: String? = null
        var description: CalendarPatch<String> = CalendarPatch.Unchanged
        var start: String? = null
        var end: CalendarPatch<String> = CalendarPatch.Unchanged
        var visibility: Visibility? = null
        var importance: Importance? = null
        var group: CalendarPatch<String> = CalendarPatch.Unchanged
        var tags: List<String>? = null
        var recurrence: CalendarPatch<StructuredRecurrence> = CalendarPatch.Unchanged
        var reminder: CalendarReminderInput? = null

        while (true) {
            when (val index = decodeElementIndex(descriptor)) {
                CompositeDecoder.DECODE_DONE -> break
                0 -> title = decodeStringElement(descriptor, index)
                1 -> description = decodePatch(index, String.serializer())
                2 -> start = decodeStringElement(descriptor, index)
                3 -> end = decodePatch(index, String.serializer())
                4 -> visibility = decodeSerializableElement(descriptor, index, Visibility.serializer())
                5 -> importance = decodeSerializableElement(descriptor, index, Importance.serializer())
                6 -> group = decodePatch(index, String.serializer())
                7 -> tags = decodeNullableSerializableElement(descriptor, index, tagsSerializer.nullable)
                8 -> recurrence = decodePatch(index, recurrenceSerializer)
                9 -> reminder = decodeSerializableElement(descriptor, index, CalendarReminderInput.serializer())
                else -> error("Unexpected CalendarChanges index: $index")
            }
        }
        CalendarChanges(title, description, start, end, visibility, importance, group, tags, recurrence, reminder)
    }

    private fun <T : Any> CompositeEncoder.encodePatch(index: Int, patch: CalendarPatch<T>, serializer: KSerializer<T>) {
        when (patch) {
            CalendarPatch.Unchanged -> Unit
            is CalendarPatch.Value -> encodeSerializableElement(descriptor, index, serializer, patch.value)
            CalendarPatch.Clear -> encodeNullableSerializableElement(descriptor, index, serializer.nullable, null)
        }
    }

    private fun <T : Any> CompositeDecoder.decodePatch(index: Int, serializer: KSerializer<T>): CalendarPatch<T> =
        decodeNullableSerializableElement(descriptor, index, serializer.nullable)?.let { CalendarPatch.Value(it) }
            ?: CalendarPatch.Clear

    private fun CalendarChanges.toJson(): JsonObject = buildJsonObject {
        title?.let { put("title", JsonPrimitive(it)) }
        putPatch("description", description) { JsonPrimitive(it) }
        start?.let { put("start", JsonPrimitive(it)) }
        putPatch("end", end) { JsonPrimitive(it) }
        visibility?.let { put("visibility", JsonPrimitive(visibilityWire(it))) }
        importance?.let { put("importance", JsonPrimitive(importanceWire(it))) }
        putPatch("group", group) { JsonPrimitive(it) }
        tags?.let { put("tags", patchJson.encodeToJsonElement(tagsSerializer, it)) }
        putPatch("recurrence", recurrence) { patchJson.encodeToJsonElement(recurrenceSerializer, it) }
        reminder?.let { put("reminder", patchJson.encodeToJsonElement(CalendarReminderInput.serializer(), it)) }
    }

    private fun <T> kotlinx.serialization.json.JsonObjectBuilder.putPatch(
        name: String,
        patch: CalendarPatch<T>,
        encode: (T) -> JsonElement,
    ) {
        when (patch) {
            CalendarPatch.Unchanged -> Unit
            is CalendarPatch.Value -> put(name, encode(patch.value))
            CalendarPatch.Clear -> put(name, JsonPrimitive(null))
        }
    }

    private fun visibilityWire(value: Visibility) = when (value) {
        Visibility.EVERYONE -> "everyone"
        Visibility.ADULTS -> "adults"
    }

    private fun importanceWire(value: Importance) = when (value) {
        Importance.NORMAL -> "normal"
        Importance.IMPORTANT -> "important"
        Importance.PINNED -> "pinned"
    }
}

/** A typed update/delete command; eventId is supplied by the URL, not duplicated in the body. */
@Serializable
data class CalendarMutationCommand(
    val operation: CalendarOperation,
    val applyTo: CalendarMutationScope,
    val changes: CalendarChanges? = null,
    val scope: CalendarScope? = null,
    val originalStart: String? = null,
    val expectedRevision: Int? = null,
) {
    companion object {
        fun update(
            applyTo: CalendarMutationScope,
            changes: CalendarChanges,
            scope: CalendarScope? = null,
            originalStart: String? = null,
            expectedRevision: Int? = null,
        ) = CalendarMutationCommand(CalendarOperation.UPDATE, applyTo, changes, scope, originalStart, expectedRevision)

        fun delete(
            applyTo: CalendarMutationScope,
            scope: CalendarScope? = null,
            originalStart: String? = null,
            expectedRevision: Int? = null,
        ) = CalendarMutationCommand(CalendarOperation.DELETE, applyTo, null, scope, originalStart, expectedRevision)
    }
}

@Serializable
data class CalendarMutationResult(
    val operation: CalendarOperation,
    val appliedTo: CalendarMutationScope,
    val eventId: String,
    val successorEventId: String? = null,
    val resultingRevision: Int? = null,
)

@Serializable
enum class CalendarErrorCode {
    @SerialName("invalid_time") INVALID_TIME,
    @SerialName("invalid_range") INVALID_RANGE,
    @SerialName("range_too_wide") RANGE_TOO_WIDE,
    @SerialName("invalid_scope") INVALID_SCOPE,
    @SerialName("invalid_mutation_scope") INVALID_MUTATION_SCOPE,
    @SerialName("forbidden") FORBIDDEN,
    @SerialName("not_found") NOT_FOUND,
    @SerialName("occurrence_not_found") OCCURRENCE_NOT_FOUND,
    @SerialName("result_too_large") RESULT_TOO_LARGE,
    @SerialName("recurrence_conflict") RECURRENCE_CONFLICT,
    @SerialName("conflict") CONFLICT,
    @SerialName("aborted") ABORTED,
    @SerialName("io_error") IO_ERROR,
    @SerialName("missing_token") MISSING_TOKEN,
    @SerialName("malformed") MALFORMED,
    @SerialName("expired") EXPIRED,
    @SerialName("signature_invalid") SIGNATURE_INVALID,
    @SerialName("wrong_purpose") WRONG_PURPOSE,
    @SerialName("user_not_found") USER_NOT_FOUND,
    @SerialName("invalid_user_record") INVALID_USER_RECORD,
}

typealias CalendarHttpErrorCode = CalendarErrorCode

@Serializable
data class CalendarError(val code: CalendarErrorCode, val message: String)

@Serializable
data class CalendarErrorResponse(
    val version: Int,
    val requestId: String,
    val error: CalendarError,
)

@Serializable
data class CalendarResponse<T>(
    val version: Int,
    val requestId: String,
    val body: T,
)

/**
 * Compatibility view consumed by existing Android/iOS screens. Its properties
 * are intentionally not serializable V1 fields; CalendarHttpClient maps this
 * view to/from the exact DTOs above.
 */
data class CalendarEvent(
    val id: String,
    val scope: CalendarScope,
    val title: String,
    val description: String? = null,
    val start: CalendarTime,
    val end: CalendarTime? = null,
    val recurrence: StructuredRecurrence? = null,
    val exdates: List<CalendarTime>? = null,
    val exceptions: List<ExceptionOverride>? = null,
    val visibility: Visibility,
    val importance: Importance,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    val notification: JsonObject? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
    val occurrenceId: String? = null,
    val originalStart: CalendarTime? = null,
    /**
     * Deprecated source-only constructor/property for unchanged platform
     * callers. It is never populated from V2 responses and is not an identity
     * used by SDK or mobile-data operations; use [eventId] instead.
     */
    @Deprecated("Use eventId; V2 does not expose baseEventId")
    val baseEventId: String? = null,
    val revision: Int = 0,
    /** Effective-occurrence marker from V2; never inferred from occurrenceId. */
    val recurring: Boolean = false,
    val reminder: CalendarReminderOutput? = null,
) {
    val eventId: String get() = id
    val persistedId: String get() = eventId
}

fun CalendarEvent.toCreateInput(): CalendarCreateInput = CalendarCreateInput(
    scope = scope.takeUnless { it == CalendarScope.ALL },
    title = title,
    description = description,
    start = start.toWireValue(),
    end = end?.toWireValue(),
    visibility = visibility,
    importance = importance,
    group = group,
    tags = tags,
    recurrence = recurrence,
    notificationPolicy = notification,
    reminder = reminder?.toEnabledInput(),
)

fun CalendarEvent.toV2(): CalendarEventV2 = CalendarEventV2(
    eventId = id,
    revision = revision,
    scope = scope,
    title = title,
    description = description,
    start = start.toWireValue(),
    end = end?.toWireValue(),
    visibility = visibility,
    importance = importance,
    group = group,
    tags = tags,
    recurrence = recurrence,
    reminder = reminder,
)

internal fun CalendarEventV2.toCompatibility(): CalendarEvent {
    reminder?.validate()
    return CalendarEvent(
        id = eventId,
        scope = scope,
        title = title,
        description = description,
        start = start.toCalendarTime(),
        end = end?.toCalendarTime(),
        recurrence = recurrence,
        visibility = visibility,
        importance = importance,
        group = group,
        tags = tags,
        revision = revision,
        recurring = false,
        reminder = reminder,
    )
}

internal fun EffectiveOccurrence.toCompatibility(): CalendarEvent {
    reminder?.validate()
    return CalendarEvent(
        id = eventId,
        scope = scope,
        title = title,
        description = description,
        start = start.toCalendarTime(),
        end = end?.toCalendarTime(),
        recurrence = recurrence,
        visibility = visibility,
        importance = importance,
        group = group,
        tags = tags,
        occurrenceId = occurrenceId,
        originalStart = originalStart.toCalendarTime(),
        revision = revision,
        recurring = recurring,
        reminder = reminder,
    )
}

private fun CalendarReminderOutput.toEnabledInput(): CalendarReminderInput? = if (!enabled) null else CalendarReminderInput(
    enabled = true,
    mode = mode,
    leadMinutes = leadMinutes,
    localTime = localTime,
    timeZone = timeZone,
)
