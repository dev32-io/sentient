package io.sentient.android.settings.calendar

import io.sentient.mobiledata.calendar.CalendarExperienceState
import io.sentient.mobiledata.calendar.CalendarMutationAvailability
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationEditorMode
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobiledata.calendar.CalendarMutationErrorKind
import io.sentient.mobiledata.calendar.CalendarMutationPhase
import io.sentient.mobiledata.calendar.CalendarMutationState
import io.sentient.mobiledata.calendar.CalendarOfflineState
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.Visibility
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class CalendarOverlayModelsTest {
    private val occurrence = EffectiveOccurrence(
        eventId = "event-1",
        occurrenceId = "occurrence-1",
        originalStart = "2026-08-01T13:00:00-04:00",
        recurring = true,
        revision = 7,
        scope = CalendarScope.HOUSEHOLD,
        title = "Dinner",
        start = "2026-08-01T13:00:00-04:00",
        end = "2026-08-01T14:00:00-04:00",
        visibility = Visibility.EVERYONE,
        importance = Importance.NORMAL,
    )

    @Test
    fun callback_for_preview_forwards_exact_authorized_identity() {
        var received: EffectiveOccurrence? = null
        val actions = actions(onEdit = { received = it })

        actions.onEdit(occurrence)

        assertSame(occurrence, received)
    }

    @Test
    fun offline_shared_gate_disables_save_delete_and_edit() {
        val draft = CalendarMutationDraft.fromOccurrence(occurrence)
        val ui = ui(
            offline = CalendarOfflineState.OFFLINE,
            // Even during a transient availability projection lag, the shared
            // offline slice is an authoritative connection-required gate.
            availability = CalendarMutationAvailability(),
            mutation = CalendarMutationState(
                phase = CalendarMutationPhase.EDITING,
                editor = CalendarMutationEditorState(CalendarMutationEditorMode.EDIT, draft),
            ),
        )

        val result = ui.overlayActionState()

        assertFalse(result.saveEnabled)
        assertFalse(result.deleteEnabled)
        assertFalse(result.editEnabled)
        assertTrue(result.connectionRequired)
    }

    @Test
    fun recurrence_scope_labels_are_explicit_and_stable() {
        assertEquals(
            listOf("This occurrence", "This and following occurrences", "Entire series"),
            CalendarMutationScope.entries.map { it.accessibleLabel() },
        )
    }

    @Test
    fun hidden_shared_state_has_no_overlay_and_focus_origins_are_distinct() {
        assertFalse(ui().hasVisibleOverlay)
        assertEquals(listOf(CalendarOverlayFocusOrigin.ADD, CalendarOverlayFocusOrigin.EVENT), CalendarOverlayFocusOrigin.entries)
        assertTrue(ui(mutation = CalendarMutationState(preview = occurrence)).hasVisibleOverlay)
    }

    @Test
    fun permission_presentation_never_discloses_server_or_event_content() {
        val error = CalendarMutationError(
            CalendarMutationErrorKind.FORBIDDEN,
            "Private event Dinner returned forbidden for member 42",
        )

        assertEquals(
            "You don’t have permission to view or change this event. No event details were disclosed.",
            error.presentationMessage(),
        )
    }

    @Test
    fun actions_preserve_draft_field_mapping() {
        val expected = CalendarMutationDraft.fromOccurrence(occurrence).copy(
            description = "Bring notes",
            tags = listOf("family", "meal"),
        )
        var received: CalendarMutationDraft? = null

        actions(onDraftChange = { received = it }).onDraftChange(expected)

        assertSame(expected, received)
        assertEquals("Bring notes", received?.description)
        assertEquals(listOf("family", "meal"), received?.tags)
    }

    private fun ui(
        offline: CalendarOfflineState = CalendarOfflineState.ONLINE,
        availability: CalendarMutationAvailability = CalendarMutationAvailability(),
        mutation: CalendarMutationState = CalendarMutationState(),
    ): CalendarUiState = CalendarExperienceState(
        anchorDate = "2026-08-01",
        selectedDate = "2026-08-01",
        todayDate = "2026-08-01",
        offline = offline,
        mutationAvailability = availability,
        mutation = mutation,
    ).toAndroidUiState()

    private fun actions(
        onEdit: (EffectiveOccurrence) -> Unit = {},
        onDraftChange: (CalendarMutationDraft) -> Unit = {},
    ) = CalendarOverlayActions(
        onDismiss = {},
        onEdit = onEdit,
        onDraftChange = onDraftChange,
        onScopeChange = {},
        onSave = {},
        onRequestDelete = {},
        onConfirmDelete = {},
        onRereadConflict = {},
        onReviewConflict = {},
        onAcknowledgeOutcome = {},
    )
}
