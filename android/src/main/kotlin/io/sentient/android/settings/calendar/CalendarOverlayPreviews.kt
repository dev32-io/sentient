package io.sentient.android.settings.calendar

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.SentientTheme
import io.sentient.mobiledata.calendar.CalendarConflictReviewState
import io.sentient.mobiledata.calendar.CalendarDeleteConfirmationState
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationEditorMode
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobiledata.calendar.CalendarMutationErrorKind
import io.sentient.mobiledata.calendar.CalendarMutationOperation
import io.sentient.mobiledata.calendar.CalendarMutationTarget
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.RecurrenceFrequency
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.calendar.Weekday

@Target(AnnotationTarget.FUNCTION, AnnotationTarget.ANNOTATION_CLASS)
@Retention(AnnotationRetention.BINARY)
@Preview(name = "390 × 844", widthDp = 390, heightDp = 844, showBackground = true)
@Preview(name = "430 × 932", widthDp = 430, heightDp = 932, showBackground = true)
private annotation class CalendarPhonePreviews

private val sampleOccurrence = EffectiveOccurrence(
    eventId = "event-1",
    occurrenceId = "occurrence-1",
    originalStart = "2026-04-18T18:00:00-07:00",
    recurring = true,
    revision = 4,
    scope = CalendarScope.HOUSEHOLD,
    title = "Household dinner",
    description = "Plan the week together.",
    start = "2026-04-18T18:00:00-07:00",
    end = "2026-04-18T19:00:00-07:00",
    visibility = Visibility.EVERYONE,
    importance = Importance.IMPORTANT,
    group = "Family",
    tags = listOf("family", "planning"),
    recurrence = StructuredRecurrence(RecurrenceFrequency.WEEKLY, weekdays = listOf(Weekday.SATURDAY)),
)
private val sampleTarget = CalendarMutationTarget(
    eventId = "event-1",
    scope = CalendarScope.HOUSEHOLD,
    expectedRevision = 4,
    occurrenceId = "occurrence-1",
    originalStart = sampleOccurrence.originalStart,
    recurring = true,
)
private val timedDraft = CalendarMutationDraft.fromOccurrence(sampleOccurrence, "America/Los_Angeles")
private val allDayDraft = CalendarMutationDraft.create(
    start = "2026-04-18",
    end = "2026-04-19",
    title = "Household day",
    scope = CalendarScope.HOUSEHOLD,
    tags = listOf("family"),
)
private val scopes = CalendarMutationScope.entries

@CalendarPhonePreviews
@Composable
private fun PreviewEventPreview() = SentientTheme {
    CalendarEventPreviewSheet(sampleOccurrence, true, false, {}, {})
}

@CalendarPhonePreviews
@Composable
private fun PreviewAddEvent() = SentientTheme {
    EditorPreview(CalendarMutationEditorState(CalendarMutationEditorMode.CREATE, allDayDraft))
}

@CalendarPhonePreviews
@Composable
private fun PreviewTimedEdit() = SentientTheme {
    EditorPreview(CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget))
}

@CalendarPhonePreviews
@Composable
private fun PreviewAllDayEdit() = SentientTheme {
    EditorPreview(CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, allDayDraft, sampleTarget))
}

@CalendarPhonePreviews
@Composable
private fun PreviewRecurrenceScope() = SentientTheme {
    EditorPreview(CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget, scopes, CalendarMutationScope.THIS_OCCURRENCE))
}

@CalendarPhonePreviews
@Composable
private fun PreviewDeleteConfirmation() = SentientTheme {
    CalendarDeleteConfirmationSheet(
        CalendarDeleteConfirmationState(sampleTarget, scopes), null, true, false, false, null, {}, {}, {},
    )
}

@CalendarPhonePreviews
@Composable
private fun PreviewConflict() = SentientTheme {
    val conflict = CalendarConflictReviewState(CalendarMutationOperation.UPDATE, sampleTarget, timedDraft)
    EditorPreview(
        CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget, scopes),
        conflict = conflict,
        error = CalendarMutationError(CalendarMutationErrorKind.CONFLICT, "This event has a newer revision."),
    )
}

@CalendarPhonePreviews
@Composable
private fun PreviewOffline() = SentientTheme {
    EditorPreview(
        CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget),
        saveEnabled = false,
        deleteEnabled = false,
        connectionRequired = true,
    )
}

@CalendarPhonePreviews
@Composable
private fun PreviewFailureError() = SentientTheme {
    EditorPreview(
        CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget),
        error = CalendarMutationError(CalendarMutationErrorKind.SERVER, "The event could not be saved. Try again."),
    )
}

@CalendarPhonePreviews
@Composable
private fun PreviewPermissionError() = SentientTheme {
    EditorPreview(
        CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, timedDraft, sampleTarget),
        saveEnabled = false,
        deleteEnabled = false,
        error = CalendarMutationError(CalendarMutationErrorKind.FORBIDDEN, "Forbidden"),
    )
}

@Preview(name = "Large font · 390 × 844", widthDp = 390, heightDp = 844, fontScale = 2f, showBackground = true)
@Composable
private fun PreviewLargeFont() = SentientTheme {
    CalendarEventPreviewSheet(sampleOccurrence, true, false, {}, {})
}

@Composable
private fun EditorPreview(
    editor: CalendarMutationEditorState,
    conflict: CalendarConflictReviewState? = null,
    error: CalendarMutationError? = null,
    saveEnabled: Boolean = true,
    deleteEnabled: Boolean = true,
    connectionRequired: Boolean = false,
) {
    CalendarEditorSheet(
        editor = editor,
        conflict = conflict,
        error = error,
        saveEnabled = saveEnabled,
        deleteEnabled = deleteEnabled,
        connectionRequired = connectionRequired,
        submitting = false,
        onDraftChange = {},
        onScopeChange = {},
        onSave = {},
        onDelete = {},
        onRereadConflict = {},
        onReviewConflict = {},
        onDismiss = {},
    )
}
