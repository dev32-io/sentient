package io.sentient.mobiledata.calendar

import io.sentient.mobilesdk.calendar.CalendarChanges
import io.sentient.mobilesdk.calendar.CalendarCreateInput
import io.sentient.mobilesdk.calendar.CalendarEvent
import io.sentient.mobilesdk.calendar.CalendarMutationCommand
import io.sentient.mobilesdk.calendar.CalendarMutationResult
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarPatch
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import kotlin.time.Instant

/** The editor lifecycle is shared; native sheets only render this state. */
enum class CalendarMutationEditorMode {
    CREATE,
    EDIT,
}

/** The operation whose result is exposed to the native surface. */
enum class CalendarMutationOperation {
    CREATE,
    UPDATE,
    DELETE,
}

/** Shared mutation lifecycle. A failed operation remains in EDITING or CONFLICT. */
enum class CalendarMutationPhase {
    IDLE,
    PREVIEWING,
    EDITING,
    DELETE_CONFIRMATION,
    SUBMITTING,
    CONFLICT,
    OUTCOME,
}

/** Typed, content-free recovery categories for online calendar writes. */
enum class CalendarMutationErrorKind {
    VALIDATION,
    CONFLICT,
    RECURRENCE_CONFLICT,
    FORBIDDEN,
    NOT_FOUND,
    CONNECTION,
    AUTHORIZATION,
    SERVER,
    CONTRACT,
    UNKNOWN,
}

data class CalendarMutationError(
    val kind: CalendarMutationErrorKind,
    val userMessage: String,
    val code: String = kind.name.lowercase(),
    val status: Int? = null,
    val recoverable: Boolean = true,
    val requiresReread: Boolean = kind == CalendarMutationErrorKind.CONFLICT ||
        kind == CalendarMutationErrorKind.RECURRENCE_CONFLICT,
) {
    val message: String get() = userMessage
    val isConflict: Boolean get() = requiresReread
    val isPermission: Boolean get() = kind == CalendarMutationErrorKind.FORBIDDEN || kind == CalendarMutationErrorKind.AUTHORIZATION
    val isOffline: Boolean get() = kind == CalendarMutationErrorKind.CONNECTION
}

/**
 * Draft values are raw V2 values, not device-local date/time objects. In
 * particular, a timed value is retained byte-for-byte when it came from the
 * server, including its numeric offset. [inputTimeZoneId] is UI-only metadata;
 * it is deliberately never sent to Calendar V2 because V2 does not provide an
 * IANA event-timezone field.
 */
data class CalendarMutationDraft(
    val title: String = "",
    val description: String? = null,
    val allDay: Boolean = true,
    val start: String = "",
    val end: String? = null,
    val scope: CalendarScope = CalendarScope.PRIVATE,
    val visibility: Visibility = Visibility.EVERYONE,
    val importance: Importance = Importance.NORMAL,
    val group: String? = null,
    val tags: List<String> = emptyList(),
    val recurrence: StructuredRecurrence? = null,
    val eventId: String? = null,
    val occurrenceId: String? = null,
    val originalStart: String? = null,
    val expectedRevision: Int? = null,
    val inputTimeZoneId: String? = null,
    /** Effective-occurrence marker; never inferred from occurrenceId alone. */
    val recurring: Boolean = false,
) {
    val rawStart: String get() = start
    val rawEnd: String? get() = end
    val rawOriginalStart: String? get() = originalStart
    val revision: Int? get() = expectedRevision
    val mutationEventId: String? get() = eventId
    val isRecurring: Boolean get() = recurring

    /** Native callers can use this source-compatible name for the editable text. */
    val descriptionText: String get() = description.orEmpty()

    companion object {
        fun create(
            start: String,
            end: String? = null,
            allDay: Boolean = CalendarDates.isValid(start),
            scope: CalendarScope = CalendarScope.PRIVATE,
            title: String = "",
            description: String? = null,
            visibility: Visibility = Visibility.EVERYONE,
            importance: Importance = Importance.NORMAL,
            group: String? = null,
            tags: List<String> = emptyList(),
            recurrence: StructuredRecurrence? = null,
            inputTimeZoneId: String? = null,
        ) = CalendarMutationDraft(
            title = title,
            description = description,
            allDay = allDay,
            start = start,
            end = end,
            scope = scope,
            visibility = visibility,
            importance = importance,
            group = group,
            tags = tags,
            recurrence = recurrence,
            inputTimeZoneId = inputTimeZoneId,
        )

        fun fromOccurrence(
            occurrence: EffectiveOccurrence,
            inputTimeZoneId: String? = null,
        ): CalendarMutationDraft = CalendarMutationDraft(
            title = occurrence.title,
            description = occurrence.description,
            allDay = CalendarDates.isValid(occurrence.start),
            start = occurrence.start,
            end = occurrence.end,
            scope = occurrence.scope,
            visibility = occurrence.visibility,
            importance = occurrence.importance,
            group = occurrence.group,
            tags = occurrence.tags,
            recurrence = occurrence.recurrence,
            eventId = occurrence.eventId,
            occurrenceId = occurrence.occurrenceId,
            originalStart = occurrence.originalStart,
            expectedRevision = occurrence.revision,
            inputTimeZoneId = inputTimeZoneId,
            recurring = occurrence.isRecurringMutationTarget(),
        )

        /** Adapts a reread result without normalizing its wire temporal values. */
        fun fromEvent(
            event: CalendarEvent,
            inputTimeZoneId: String? = null,
        ): CalendarMutationDraft = CalendarMutationDraft(
            title = event.title,
            description = event.description,
            allDay = CalendarDates.isValid(event.start.toWireValue()),
            start = event.start.toWireValue(),
            end = event.end?.toWireValue(),
            scope = event.scope,
            visibility = event.visibility,
            importance = event.importance,
            group = event.group,
            tags = event.tags,
            recurrence = event.recurrence,
            eventId = event.eventId,
            occurrenceId = event.occurrenceId,
            originalStart = event.originalStart?.toWireValue(),
            expectedRevision = event.revision,
            inputTimeZoneId = inputTimeZoneId,
            recurring = event.recurring || event.recurrence != null,
        )
    }
}

typealias CalendarDraft = CalendarMutationDraft
typealias CalendarEventDraft = CalendarMutationDraft
typealias CalendarEditorDraft = CalendarMutationDraft

/** Identity required to address a V2 persisted event or effective occurrence. */
data class CalendarMutationTarget(
    val eventId: String,
    val scope: CalendarScope,
    val expectedRevision: Int,
    val occurrenceId: String? = null,
    val originalStart: String? = null,
    val recurring: Boolean = false,
) {
    val revision: Int get() = expectedRevision
    val rawOriginalStart: String? get() = originalStart

    companion object {
        fun fromOccurrence(occurrence: EffectiveOccurrence): CalendarMutationTarget? {
            if (occurrence.eventId.isBlank() || occurrence.scope == CalendarScope.ALL || occurrence.revision <= 0) return null
            return CalendarMutationTarget(
                eventId = occurrence.eventId,
                scope = occurrence.scope,
                expectedRevision = occurrence.revision,
                occurrenceId = occurrence.occurrenceId,
                originalStart = occurrence.originalStart,
                recurring = occurrence.isRecurringMutationTarget(),
            )
        }

        fun fromEvent(event: CalendarEvent): CalendarMutationTarget? {
            if (event.eventId.isBlank() || event.scope == CalendarScope.ALL || event.revision <= 0) return null
            return CalendarMutationTarget(
                eventId = event.eventId,
                scope = event.scope,
                expectedRevision = event.revision,
                occurrenceId = event.occurrenceId,
                originalStart = event.originalStart?.toWireValue(),
                recurring = event.recurring || event.recurrence != null ||
                    event.originalStart?.toWireValue()?.let { it != event.start.toWireValue() } == true,
            )
        }
    }
}

/** The shared editor state includes the immutable target separately from draft fields. */
data class CalendarMutationEditorState(
    val mode: CalendarMutationEditorMode,
    val draft: CalendarMutationDraft,
    val target: CalendarMutationTarget? = null,
    val applicableScopes: List<CalendarMutationScope> = listOf(CalendarMutationScope.ENTIRE_SERIES),
    val selectedScope: CalendarMutationScope? = null,
) {
    val isCreate: Boolean get() = mode == CalendarMutationEditorMode.CREATE
    val isEdit: Boolean get() = mode == CalendarMutationEditorMode.EDIT
    val recurring: Boolean get() = applicableScopes.size > 1
    val mutationScope: CalendarMutationScope? get() = selectedScope
    val eventId: String? get() = target?.eventId ?: draft.eventId
}

data class CalendarDeleteConfirmationState(
    val target: CalendarMutationTarget,
    val applicableScopes: List<CalendarMutationScope>,
    val selectedScope: CalendarMutationScope? = null,
) {
    val mutationScope: CalendarMutationScope? get() = selectedScope
}

data class CalendarConflictReviewState(
    val operation: CalendarMutationOperation,
    val target: CalendarMutationTarget,
    val draft: CalendarMutationDraft,
    val rereadInFlight: Boolean = false,
    val authoritativeEvent: CalendarEvent? = null,
    val reviewed: Boolean = false,
) {
    val latestEvent: CalendarEvent? get() = authoritativeEvent
    val requiresReview: Boolean get() = !reviewed
}

/** A typed request keeps the URL eventId adjacent to the body command. */
sealed interface CalendarMutationRequest {
    val operation: CalendarMutationOperation

    data class Create(val input: CalendarCreateInput) : CalendarMutationRequest {
        override val operation: CalendarMutationOperation = CalendarMutationOperation.CREATE
    }

    data class Update(
        val eventId: String,
        val command: CalendarMutationCommand,
    ) : CalendarMutationRequest {
        override val operation: CalendarMutationOperation = CalendarMutationOperation.UPDATE
    }

    data class Delete(
        val eventId: String,
        val command: CalendarMutationCommand,
    ) : CalendarMutationRequest {
        override val operation: CalendarMutationOperation = CalendarMutationOperation.DELETE
    }
}

data class CalendarMutationSuccess(
    val operation: CalendarMutationOperation,
    val event: CalendarEvent? = null,
    val mutation: CalendarMutationResult? = null,
    val successorEventId: String? = mutation?.successorEventId,
    val affectedWindows: List<io.sentient.mobiledata.cache.CalendarCacheWindow> = emptyList(),
) {
    val result: CalendarMutationResult? get() = mutation
}

sealed interface CalendarMutationOutcome {
    val operation: CalendarMutationOperation

    data class Success(
        override val operation: CalendarMutationOperation,
        val value: CalendarMutationSuccess,
    ) : CalendarMutationOutcome {
        val event: CalendarEvent? get() = value.event
        val mutation: CalendarMutationResult? get() = value.mutation
        val successorEventId: String? get() = value.successorEventId
        val affectedWindows: List<io.sentient.mobiledata.cache.CalendarCacheWindow> get() = value.affectedWindows
    }

    data class Failure(
        override val operation: CalendarMutationOperation,
        val error: CalendarMutationError,
        val draft: CalendarMutationDraft? = null,
        val request: CalendarMutationRequest? = null,
        val eventId: String? = draft?.eventId,
    ) : CalendarMutationOutcome
}

/**
 * State consumed by native preview/editor/confirmation sheets. Draft and
 * authoritative data are intentionally in-memory only; the cache store has no
 * mutation queue or draft table.
 */
data class CalendarMutationState(
    val phase: CalendarMutationPhase = CalendarMutationPhase.IDLE,
    val preview: EffectiveOccurrence? = null,
    val editor: CalendarMutationEditorState? = null,
    val deleteConfirmation: CalendarDeleteConfirmationState? = null,
    val pendingRequest: CalendarMutationRequest? = null,
    val error: CalendarMutationError? = null,
    val conflict: CalendarConflictReviewState? = null,
    val outcome: CalendarMutationOutcome? = null,
    val successorEventId: String? = null,
    val affectedWindows: List<io.sentient.mobiledata.cache.CalendarCacheWindow> = emptyList(),
) {
    val draft: CalendarMutationDraft? get() = editor?.draft
    val mutationDraft: CalendarMutationDraft? get() = draft
    val previewOccurrence: EffectiveOccurrence? get() = preview
    val editorState: CalendarMutationEditorState? get() = editor
    val deleteConfirmationState: CalendarDeleteConfirmationState? get() = deleteConfirmation
    val currentError: CalendarMutationError? get() = error
    val latestOutcome: CalendarMutationOutcome? get() = outcome
    val latestSuccessorEventId: String? get() = successorEventId
    val target: CalendarMutationTarget? get() = editor?.target ?: deleteConfirmation?.target ?: conflict?.target
    val mutationScope: CalendarMutationScope? get() = editor?.selectedScope ?: deleteConfirmation?.selectedScope
    val applicableScopes: List<CalendarMutationScope> get() = editor?.applicableScopes
        ?: deleteConfirmation?.applicableScopes.orEmpty()
    val isPreviewOpen: Boolean get() = preview != null
    val isEditorOpen: Boolean get() = editor != null
    val isDeleteConfirmationOpen: Boolean get() = deleteConfirmation != null
    val isSubmitting: Boolean get() = phase == CalendarMutationPhase.SUBMITTING
    val hasConflict: Boolean get() = conflict != null || error?.isConflict == true
    val lastOutcome: CalendarMutationOutcome? get() = outcome
}

typealias CalendarMutationResultState = CalendarMutationState
typealias CalendarEditorState = CalendarMutationEditorState

/** A stable identity for a visible recurring row. */
fun EffectiveOccurrence.isRecurringMutationTarget(): Boolean = recurring || recurrence != null || originalStart != start

fun applicableCalendarMutationScopes(occurrence: EffectiveOccurrence): List<CalendarMutationScope> =
    if (occurrence.isRecurringMutationTarget()) CalendarMutationScope.entries.toList()
    else listOf(CalendarMutationScope.ENTIRE_SERIES)

fun applicableCalendarMutationScopes(event: CalendarEvent): List<CalendarMutationScope> =
    if (event.recurring || event.recurrence != null ||
        event.originalStart?.toWireValue()?.let { it != event.start.toWireValue() } == true
    ) CalendarMutationScope.entries.toList()
    else listOf(CalendarMutationScope.ENTIRE_SERIES)

/** Public build result for native validation surfaces. */
sealed interface CalendarCommandBuildResult<out T> {
    data class Success<T>(val value: T) : CalendarCommandBuildResult<T>
    data class Failure(val error: CalendarMutationError) : CalendarCommandBuildResult<Nothing>
}

typealias CalendarMutationBuildResult<T> = CalendarCommandBuildResult<T>

fun buildCalendarCreateInput(draft: CalendarMutationDraft): CalendarCommandBuildResult<CalendarCreateInput> =
    runBuild { CalendarCreateInputBuilder.build(draft) }

fun buildCalendarUpdateRequest(
    draft: CalendarMutationDraft,
    applyTo: CalendarMutationScope,
): CalendarCommandBuildResult<CalendarMutationRequest.Update> = runBuild {
    CalendarMutationRequestBuilder.update(draft, applyTo)
}

fun buildCalendarDeleteRequest(
    draft: CalendarMutationDraft,
    applyTo: CalendarMutationScope,
): CalendarCommandBuildResult<CalendarMutationRequest.Delete> = runBuild {
    CalendarMutationRequestBuilder.delete(draft, applyTo)
}

/** Convenience names used by platform adapters. */
fun buildCalendarUpdateCommand(
    draft: CalendarMutationDraft,
    applyTo: CalendarMutationScope,
): CalendarCommandBuildResult<CalendarMutationCommand> = buildCalendarUpdateRequest(draft, applyTo).map { it.command }

fun buildCalendarDeleteCommand(
    draft: CalendarMutationDraft,
    applyTo: CalendarMutationScope,
): CalendarCommandBuildResult<CalendarMutationCommand> = buildCalendarDeleteRequest(draft, applyTo).map { it.command }

/** Object-shaped facade for Swift/Java adapters that prefer a namespaced builder. */
object CalendarMutationCommands {
    fun create(draft: CalendarMutationDraft): CalendarCommandBuildResult<CalendarCreateInput> =
        buildCalendarCreateInput(draft)

    fun update(
        draft: CalendarMutationDraft,
        applyTo: CalendarMutationScope,
    ): CalendarCommandBuildResult<CalendarMutationRequest.Update> =
        buildCalendarUpdateRequest(draft, applyTo)

    fun delete(
        draft: CalendarMutationDraft,
        applyTo: CalendarMutationScope,
    ): CalendarCommandBuildResult<CalendarMutationRequest.Delete> =
        buildCalendarDeleteRequest(draft, applyTo)
}

typealias CalendarMutationRequestState = CalendarMutationRequest

private inline fun <T> runBuild(block: () -> T): CalendarCommandBuildResult<T> = try {
    CalendarCommandBuildResult.Success(block())
} catch (error: CalendarMutationValidationException) {
    CalendarCommandBuildResult.Failure(error.error)
}

private fun <T, R> CalendarCommandBuildResult<T>.map(transform: (T) -> R): CalendarCommandBuildResult<R> = when (this) {
    is CalendarCommandBuildResult.Success -> CalendarCommandBuildResult.Success(transform(value))
    is CalendarCommandBuildResult.Failure -> this
}

private object CalendarCreateInputBuilder {
    fun build(draft: CalendarMutationDraft): CalendarCreateInput {
        validateDraft(draft, requireIdentity = false)
        require(draft.scope == CalendarScope.PRIVATE || draft.scope == CalendarScope.HOUSEHOLD) {
            validation("Choose a private or household calendar.", "invalid_scope")
        }
        return CalendarCreateInput(
            scope = draft.scope,
            title = draft.title.trim(),
            description = draft.description,
            start = draft.start,
            end = draft.end,
            visibility = draft.visibility,
            importance = draft.importance,
            group = draft.group?.trim()?.takeIf(String::isNotEmpty),
            tags = normalizeTags(draft.tags),
            recurrence = draft.recurrence,
        )
    }
}

private object CalendarMutationRequestBuilder {
    fun update(draft: CalendarMutationDraft, applyTo: CalendarMutationScope): CalendarMutationRequest.Update {
        validateDraft(draft, requireIdentity = true)
        validateApplicableScope(draft, applyTo)
        val eventId = draft.eventId ?: notFound("This calendar event is no longer available.")
        val scope = writableScope(draft.scope)
        val originalStart = originalStartFor(draft, applyTo)
        val command = CalendarMutationCommand.update(
            applyTo = applyTo,
            changes = CalendarChanges(
                title = draft.title.trim(),
                description = draft.description?.let(CalendarPatch<String>::Value) ?: CalendarPatch.Clear,
                start = draft.start,
                end = draft.end?.let(CalendarPatch<String>::Value) ?: CalendarPatch.Clear,
                visibility = draft.visibility,
                importance = draft.importance,
                group = draft.group?.trim()?.takeIf(String::isNotEmpty)?.let(CalendarPatch<String>::Value)
                    ?: CalendarPatch.Clear,
                tags = normalizeTags(draft.tags),
                recurrence = draft.recurrence?.let(CalendarPatch<StructuredRecurrence>::Value) ?: CalendarPatch.Clear,
            ),
            scope = scope,
            originalStart = originalStart,
            expectedRevision = draft.expectedRevision,
        )
        return CalendarMutationRequest.Update(eventId, command)
    }

    fun delete(draft: CalendarMutationDraft, applyTo: CalendarMutationScope): CalendarMutationRequest.Delete {
        validateDraft(draft, requireIdentity = true, validateFields = false)
        validateApplicableScope(draft, applyTo)
        val eventId = draft.eventId ?: notFound("This calendar event is no longer available.")
        val scope = writableScope(draft.scope)
        val originalStart = originalStartFor(draft, applyTo)
        return CalendarMutationRequest.Delete(
            eventId = eventId,
            command = CalendarMutationCommand.delete(
                applyTo = applyTo,
                scope = scope,
                originalStart = originalStart,
                expectedRevision = draft.expectedRevision,
            ),
        )
    }
}

private fun validateApplicableScope(draft: CalendarMutationDraft, applyTo: CalendarMutationScope) {
    val recurring = draft.recurring || draft.recurrence != null
    if (!recurring && applyTo != CalendarMutationScope.ENTIRE_SERIES) {
        validation("This event has no applicable recurrence scope.", "invalid_mutation_scope")
    }
}

private fun validateDraft(
    draft: CalendarMutationDraft,
    requireIdentity: Boolean,
    validateFields: Boolean = true,
) {
    if (validateFields) {
        require(draft.title.trim().isNotEmpty()) { validation("Add a title before saving.", "validation") }
        require(draft.start.isNotBlank() && validWireTime(draft.start, draft.allDay)) {
            validation("Check the event start time.", "invalid_time")
        }
        if (draft.end != null) {
            require(validWireTime(draft.end, draft.allDay)) {
                validation("Check the event end time.", "invalid_time")
            }
            require(compareWireTimes(draft.start, draft.end, draft.allDay) <= 0) {
                validation("End must be on or after the start.", "invalid_range")
            }
        }
        validateRecurrence(draft.recurrence)
    }
    if (requireIdentity) {
        if (draft.eventId.isNullOrBlank()) notFound("This calendar event is no longer available.")
        if (draft.expectedRevision == null || draft.expectedRevision <= 0) {
            throw CalendarMutationValidationException(
                CalendarMutationError(
                    kind = CalendarMutationErrorKind.CONFLICT,
                    userMessage = "This calendar event has no current revision.",
                    code = "conflict",
                ),
            )
        }
    }
}

private fun writableScope(scope: CalendarScope): CalendarScope = when (scope) {
    CalendarScope.PRIVATE,
    CalendarScope.HOUSEHOLD,
    -> scope
    CalendarScope.ALL -> validation("Choose a writable calendar.", "invalid_scope")
}

private fun originalStartFor(draft: CalendarMutationDraft, applyTo: CalendarMutationScope): String? {
    if (applyTo == CalendarMutationScope.ENTIRE_SERIES) return null
    require(draft.originalStart?.isNotBlank() == true && validWireTime(
        draft.originalStart,
        CalendarDates.isValid(draft.originalStart),
    )) {
        validation("Choose an occurrence with an original start.", "invalid_mutation_scope")
    }
    return draft.originalStart
}

private fun validWireTime(value: String, allDay: Boolean): Boolean {
    if (allDay) return CalendarDates.isValid(value)
    if (CalendarDates.isValid(value)) return false
    // Instant.parse validates the instant while leaving the original offset
    // spelling untouched in the command. V2 requires an offset-bearing value;
    // a local datetime without Z/offset is not accepted here.
    if (!value.contains('T')) return false
    if (!value.endsWith("Z", ignoreCase = true) && !value.contains(Regex("[+-]\\d{2}:?\\d{2}$"))) return false
    return runCatching { Instant.parse(value) }.isSuccess
}

private fun compareWireTimes(start: String, end: String, allDay: Boolean): Int = if (allDay) {
    start.compareTo(end)
} else {
    Instant.parse(start).compareTo(Instant.parse(end))
}

private fun validateRecurrence(recurrence: StructuredRecurrence?) {
    if (recurrence == null) return
    val interval = recurrence.interval
    require(interval == null || interval > 0) {
        validation("Repeat interval must be positive.", "invalid_recurrence")
    }
    require((recurrence.count == null) xor (recurrence.until == null)) {
        validation("A repeat needs exactly one end condition.", "invalid_recurrence")
    }
    val count = recurrence.count
    require(count == null || count > 0) {
        validation("Repeat count must be positive.", "invalid_recurrence")
    }
    if (recurrence.frequency == io.sentient.mobilesdk.calendar.RecurrenceFrequency.WEEKLY) {
        require(!recurrence.weekdays.isNullOrEmpty()) {
            validation("Choose at least one weekday.", "invalid_recurrence")
        }
    }
    require(recurrence.weekdays?.distinct()?.size == recurrence.weekdays?.size) {
        validation("Repeat weekdays must be unique.", "invalid_recurrence")
    }
    recurrence.until?.let {
        // V2 may return an all-day recurrence bound as a canonical offset-bearing
        // instant. Validate its own wire kind rather than rewriting it through
        // the event's start kind.
        val untilIsAllDay = CalendarDates.isValid(it)
        require(validWireTime(it, untilIsAllDay)) {
            validation("Check the repeat end date.", "invalid_recurrence")
        }
    }
}

private fun normalizeTags(tags: List<String>): List<String> = tags
    .map(String::trim)
    .filter(String::isNotEmpty)
    .distinct()

private fun validation(message: String, code: String): Nothing = throw CalendarMutationValidationException(
    CalendarMutationError(CalendarMutationErrorKind.VALIDATION, message, code = code),
)

private fun notFound(message: String): Nothing = throw CalendarMutationValidationException(
    CalendarMutationError(CalendarMutationErrorKind.NOT_FOUND, message, code = "not_found"),
)

private class CalendarMutationValidationException(val error: CalendarMutationError) : IllegalArgumentException(error.userMessage)

/** Small source-compatible helpers for callers that hold result envelopes. */
val CalendarMutationError.isValidation: Boolean get() = kind == CalendarMutationErrorKind.VALIDATION
val CalendarMutationError.isNotFound: Boolean get() = kind == CalendarMutationErrorKind.NOT_FOUND
val CalendarMutationError.isServerFailure: Boolean get() = kind == CalendarMutationErrorKind.SERVER
val CalendarMutationResult.appliedScope: CalendarMutationScope get() = appliedTo
val CalendarMutationResult.successorId: String? get() = successorEventId
