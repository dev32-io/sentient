package io.sentient.android.settings.calendar

import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationAvailabilityReason
import io.sentient.mobiledata.calendar.CalendarMutationEditorMode
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence

/** The control that opened an overlay. The host uses this to restore focus after dismissal. */
enum class CalendarOverlayFocusOrigin {
    ADD,
    EVENT,
}

/** Controlled callbacks forwarded to the shared CalendarExperience by CalendarScreen. */
data class CalendarOverlayActions(
    val onDismiss: () -> Unit,
    val onEdit: (EffectiveOccurrence) -> Unit,
    val onDraftChange: (CalendarMutationDraft) -> Unit,
    val onScopeChange: (CalendarMutationScope) -> Unit,
    val onSave: (CalendarMutationDraft) -> Unit,
    val onRequestDelete: () -> Unit,
    val onConfirmDelete: (CalendarMutationScope?) -> Unit,
    val onRereadConflict: () -> Unit,
    val onReviewConflict: (CalendarMutationDraft) -> Unit,
    val onAcknowledgeOutcome: () -> Unit,
)

/** Stable action policy derived only from shared state; Compose does not recreate mutation policy. */
data class CalendarOverlayActionState(
    val saveEnabled: Boolean,
    val deleteEnabled: Boolean,
    val editEnabled: Boolean,
    val connectionRequired: Boolean,
    val validationMessage: String?,
)

fun CalendarUiState.overlayActionState(): CalendarOverlayActionState {
    val editing = editor?.mode == CalendarMutationEditorMode.EDIT
    val conflictAllowsSave = conflict?.canSubmit ?: true
    val connectionRequired = isOffline || mutationAvailability.reason == CalendarMutationAvailabilityReason.OFFLINE ||
        mutationAvailability.reason == CalendarMutationAvailabilityReason.UNAVAILABLE
    return CalendarOverlayActionState(
        saveEnabled = !connectionRequired && !isSubmitting && conflictAllowsSave &&
            editor?.canSubmitDraft == true &&
            if (editing) mutationAvailability.canEdit else mutationAvailability.canCreate,
        deleteEnabled = !connectionRequired && !isSubmitting && mutationAvailability.canDelete,
        editEnabled = !connectionRequired && !isSubmitting && mutationAvailability.canEdit,
        connectionRequired = connectionRequired,
        validationMessage = editor?.submissionValidationError?.presentationMessage(),
    )
}

val CalendarUiState.hasVisibleOverlay: Boolean
    get() = preview != null || editor != null || deleteConfirmation != null || conflict != null || outcome != null

fun CalendarMutationError.presentationMessage(): String = if (isPermission) {
    "You don’t have permission to view or change this event. No event details were disclosed."
} else userMessage

fun CalendarMutationScope.accessibleLabel(): String = when (this) {
    CalendarMutationScope.THIS_OCCURRENCE -> "This occurrence"
    CalendarMutationScope.THIS_AND_FOLLOWING -> "This and following occurrences"
    CalendarMutationScope.ENTIRE_SERIES -> "Entire series"
}

internal fun CalendarMutationEditorState.sheetTitle(): String = if (isCreate) "Add event" else "Edit event"
