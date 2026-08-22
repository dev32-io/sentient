@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package io.sentient.android.settings.calendar

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.Fraunces
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.mobiledata.calendar.CalendarConflictReviewState
import io.sentient.mobiledata.calendar.CalendarDeleteConfirmationState
import io.sentient.mobiledata.calendar.CalendarMutationDraft
import io.sentient.mobiledata.calendar.CalendarMutationEditorState
import io.sentient.mobiledata.calendar.CalendarMutationError
import io.sentient.mobiledata.calendar.CalendarMutationOutcome
import io.sentient.mobiledata.calendar.CalendarMutationPhase
import io.sentient.mobilesdk.calendar.CalendarMutationScope
import io.sentient.mobilesdk.calendar.CalendarScope
import io.sentient.mobilesdk.calendar.EffectiveOccurrence
import io.sentient.mobilesdk.calendar.Importance
import io.sentient.mobilesdk.calendar.RecurrenceFrequency
import io.sentient.mobilesdk.calendar.StructuredRecurrence
import io.sentient.mobilesdk.calendar.Visibility
import io.sentient.mobilesdk.calendar.Weekday
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Controlled Calendar V2 overlays. This function is always safe to keep in the
 * composition: when shared state has no overlay, it emits no UI or semantics.
 * [originFocusRequester] belongs to the event row or Add control that opened it.
 */
@Composable
fun CalendarOverlays(
    state: CalendarUiState,
    actions: CalendarOverlayActions,
    origin: CalendarOverlayFocusOrigin?,
    originFocusRequester: FocusRequester?,
    fallbackFocusRequester: FocusRequester? = null,
    modifier: Modifier = Modifier,
) {
    val visible = state.hasVisibleOverlay
    var lastOrigin by remember { mutableStateOf<CalendarOverlayFocusOrigin?>(null) }
    var lastOriginRequester by remember { mutableStateOf<FocusRequester?>(null) }
    LaunchedEffect(visible, origin, originFocusRequester) {
        if (visible) {
            if (origin != null) lastOrigin = origin
            if (originFocusRequester != null) lastOriginRequester = originFocusRequester
        } else if (lastOrigin != null) {
            val restored = runCatching { lastOriginRequester?.requestFocus() == true }.getOrDefault(false)
            if (!restored) runCatching { fallbackFocusRequester?.requestFocus() }
            lastOrigin = null
            lastOriginRequester = null
        }
    }
    if (!visible) return

    val actionState = state.overlayActionState()
    when {
        state.deleteConfirmation != null -> CalendarDeleteConfirmationSheet(
            confirmation = state.deleteConfirmation,
            selectedScope = state.deleteConfirmation.selectedScope,
            enabled = actionState.deleteEnabled,
            connectionRequired = actionState.connectionRequired,
            submitting = state.isSubmitting,
            error = state.mutationError,
            onScopeChange = actions.onScopeChange,
            onConfirm = actions.onConfirmDelete,
            onDismiss = actions.onDismiss,
            modifier = modifier,
        )
        state.outcome != null -> CalendarOutcomeSheet(
            outcome = state.outcome,
            onDismiss = actions.onAcknowledgeOutcome,
            modifier = modifier,
        )
        state.editor != null -> CalendarEditorSheet(
            editor = state.editor,
            conflict = state.conflict,
            error = state.mutationError,
            saveEnabled = actionState.saveEnabled,
            deleteEnabled = actionState.deleteEnabled,
            connectionRequired = actionState.connectionRequired,
            validationMessage = actionState.validationMessage,
            submitting = state.mutationPhase == CalendarMutationPhase.SUBMITTING,
            onDraftChange = actions.onDraftChange,
            onScopeChange = actions.onScopeChange,
            onSave = actions.onSave,
            onDelete = actions.onRequestDelete,
            onRereadConflict = actions.onRereadConflict,
            onReviewConflict = actions.onReviewConflict,
            onDismiss = actions.onDismiss,
            modifier = modifier,
        )
        state.conflict != null -> CalendarConflictSheet(
            conflict = state.conflict,
            error = state.mutationError,
            onReread = actions.onRereadConflict,
            onReview = actions.onReviewConflict,
            onDismiss = actions.onDismiss,
            modifier = modifier,
        )
        state.preview != null -> CalendarEventPreviewSheet(
            occurrence = state.preview,
            editEnabled = actionState.editEnabled,
            connectionRequired = actionState.connectionRequired,
            onEdit = actions.onEdit,
            onDismiss = actions.onDismiss,
            modifier = modifier,
        )
    }
}

@Composable
fun CalendarEventPreviewSheet(
    occurrence: EffectiveOccurrence,
    editEnabled: Boolean,
    connectionRequired: Boolean,
    onEdit: (EffectiveOccurrence) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) = CalendarSheet(
    "Event preview",
    onDismiss,
    modifier.testTag("calendar-preview-sheet"),
    footer = {
        SheetActionRow {
            SecondaryAction("Close", onDismiss, Modifier.weight(1f))
            PrimaryAction(
                "Edit",
                { onEdit(occurrence) },
                editEnabled,
                Modifier.weight(1f).testTag("calendar-preview-edit"),
            )
        }
    },
) {
    Text(
        text = occurrence.tags.firstOrNull()?.uppercase()?.let { "$it · EVENT PREVIEW" } ?: "EVENT PREVIEW",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
        occurrence.title,
        style = MaterialTheme.typography.headlineMedium.copy(fontFamily = Fraunces),
        modifier = Modifier.semantics { heading() },
    )
    Text(formatOccurrenceTime(occurrence), color = MaterialTheme.colorScheme.onSurfaceVariant)
    occurrence.description?.takeIf { it.isNotBlank() }?.let { Text(it) }
    MetadataDivider(
        listOfNotNull(
            "Calendar" to occurrence.scope.displayName(),
            "Visibility" to occurrence.visibility.displayName(),
            "Importance" to occurrence.importance.displayName(),
            occurrence.group?.takeIf { it.isNotBlank() }?.let { "Group" to it },
            occurrence.tags.takeIf { it.isNotEmpty() }?.let { "Tags" to it.joinToString() },
            occurrence.recurrence?.let { "Repeats" to it.displayName() },
        ),
    )
    if (connectionRequired) ConnectionRequiredNotice("Editing requires a connection.")
}

@Composable
fun CalendarEditorSheet(
    editor: CalendarMutationEditorState,
    conflict: CalendarConflictReviewState?,
    error: CalendarMutationError?,
    saveEnabled: Boolean,
    deleteEnabled: Boolean,
    connectionRequired: Boolean,
    validationMessage: String?,
    submitting: Boolean,
    onDraftChange: (CalendarMutationDraft) -> Unit,
    onScopeChange: (CalendarMutationScope) -> Unit,
    onSave: (CalendarMutationDraft) -> Unit,
    onDelete: () -> Unit,
    onRereadConflict: () -> Unit,
    onReviewConflict: (CalendarMutationDraft) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) = CalendarSheet(
    editor.sheetTitle(),
    onDismiss,
    modifier.testTag("calendar-editor-sheet"),
    dismissEnabled = !submitting,
    footer = {
        validationMessage?.takeIf { !saveEnabled && !connectionRequired }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("calendar-editor-validation")
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        SheetActionRow {
            SecondaryAction("Cancel", onDismiss, Modifier.weight(1f), enabled = !submitting)
            PrimaryAction(
                if (submitting) "Saving…" else "Save event",
                { onSave(editor.draft) },
                saveEnabled,
                Modifier.weight(1f).testTag("calendar-editor-save"),
                submitting,
            )
        }
    },
) {
    val draft = editor.draft
    val titleFocus = remember { FocusRequester() }
    LaunchedEffect(editor.eventId) { titleFocus.requestFocus() }
    SheetHeader(editor.sheetTitle(), onDismiss, enabled = !submitting)
    Text(
        if (editor.isCreate) "Sentient will check household conflicts before saving."
        else "Update the supported Calendar V2 event details.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    OverlayError(error)
    conflict?.let {
        ConflictPanel(it, draft, onRereadConflict, onReviewConflict)
    }
    if (connectionRequired) ConnectionRequiredNotice(
        if (editor.isCreate) "Connect to save this event." else "Connect to save or delete this event.",
    )
    OutlinedTextField(
        value = draft.title,
        onValueChange = { onDraftChange(draft.copy(title = it)) },
        label = { Text("Event title") },
        placeholder = { Text("What is happening?") },
        singleLine = true,
        enabled = !submitting,
        modifier = Modifier.fillMaxWidth().focusRequester(titleFocus).testTag("calendar-editor-title"),
    )
    OutlinedTextField(
        value = draft.description.orEmpty(),
        onValueChange = { onDraftChange(draft.copy(description = it.ifBlank { null })) },
        label = { Text("Description") },
        minLines = 3,
        enabled = !submitting,
        modifier = Modifier.fillMaxWidth().testTag("calendar-editor-description"),
    )
    LabeledSwitch("All-day event", draft.allDay, !submitting) { allDay ->
        onDraftChange(draft.convertAllDay(allDay))
    }
    DateTimeFields(draft, !submitting, onDraftChange)
    SectionLabel("Calendar")
    EnumOptions(
        values = listOf(CalendarScope.PRIVATE, CalendarScope.HOUSEHOLD),
        selected = draft.scope,
        label = { it.displayName() },
        enabled = !submitting,
    ) { onDraftChange(draft.copy(scope = it)) }
    SectionLabel("Visibility")
    EnumOptions(Visibility.entries, draft.visibility, { it.displayName() }, !submitting) {
        onDraftChange(draft.copy(visibility = it))
    }
    SectionLabel("Importance")
    EnumOptions(Importance.entries, draft.importance, { it.displayName() }, !submitting) {
        onDraftChange(draft.copy(importance = it))
    }
    OutlinedTextField(
        draft.group.orEmpty(),
        { onDraftChange(draft.copy(group = it.ifBlank { null })) },
        label = { Text("Group") },
        singleLine = true,
        enabled = !submitting,
        modifier = Modifier.fillMaxWidth().testTag("calendar-editor-group"),
    )
    OutlinedTextField(
        draft.tags.joinToString(", "),
        { value -> onDraftChange(draft.copy(tags = value.split(',').map(String::trim).filter(String::isNotEmpty))) },
        label = { Text("Tags") },
        supportingText = { Text("Separate tags with commas") },
        singleLine = true,
        enabled = !submitting,
        modifier = Modifier.fillMaxWidth().testTag("calendar-editor-tags"),
    )
    RecurrenceFields(draft, !submitting, onDraftChange)
    if (editor.applicableScopes.size > 1) {
        RecurrenceScopeChoices(editor.applicableScopes, editor.selectedScope, !submitting, onScopeChange)
    }
    if (editor.isEdit) {
        OutlinedButton(
            onClick = onDelete,
            enabled = deleteEnabled,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("calendar-editor-delete"),
        ) { Text("Delete event") }
    }
}

@Composable
fun CalendarDeleteConfirmationSheet(
    confirmation: CalendarDeleteConfirmationState,
    selectedScope: CalendarMutationScope?,
    enabled: Boolean,
    connectionRequired: Boolean,
    submitting: Boolean,
    error: CalendarMutationError?,
    onScopeChange: (CalendarMutationScope) -> Unit,
    onConfirm: (CalendarMutationScope?) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) = CalendarSheet("Delete event", onDismiss, modifier.testTag("calendar-delete-sheet"), dismissEnabled = !submitting) {
    SheetHeader("Delete event?", onDismiss, enabled = !submitting)
    Text("This action cannot be undone. Choose which recurring events to delete.")
    OverlayError(error)
    if (connectionRequired) ConnectionRequiredNotice("Connect to delete this event.")
    RecurrenceScopeChoices(confirmation.applicableScopes, selectedScope, !submitting, onScopeChange)
    SheetActionRow {
        SecondaryAction("Cancel", onDismiss, Modifier.weight(1f), enabled = !submitting)
        DestructiveAction(
            if (submitting) "Deleting…" else "Delete",
            { onConfirm(selectedScope) },
            enabled && (confirmation.applicableScopes.size <= 1 || selectedScope != null),
            Modifier.weight(1f).testTag("calendar-delete-confirm"),
            submitting,
        )
    }
}

@Composable
private fun CalendarConflictSheet(
    conflict: CalendarConflictReviewState,
    error: CalendarMutationError?,
    onReread: () -> Unit,
    onReview: (CalendarMutationDraft) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier,
) = CalendarSheet("Event changed", onDismiss, modifier.testTag("calendar-conflict-sheet")) {
    SheetHeader("Review newer changes", onDismiss)
    OverlayError(error)
    ConflictPanel(conflict, conflict.draft, onReread, onReview)
    SecondaryAction("Cancel", onDismiss, Modifier.fillMaxWidth())
}

@Composable
private fun CalendarOutcomeSheet(
    outcome: CalendarMutationOutcome,
    onDismiss: () -> Unit,
    modifier: Modifier,
) = CalendarSheet("Calendar update result", onDismiss, modifier.testTag("calendar-outcome-sheet")) {
    when (outcome) {
        is CalendarMutationOutcome.Success -> {
            SheetHeader("Calendar updated", onDismiss)
            Text("Your calendar changes were saved.", modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        is CalendarMutationOutcome.Failure -> {
            SheetHeader("Couldn’t update calendar", onDismiss)
            OverlayError(outcome.error)
        }
    }
    PrimaryAction("Done", onDismiss, true, Modifier.fillMaxWidth())
}

@Composable
private fun CalendarSheet(
    paneName: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    dismissEnabled: Boolean = true,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    val density = LocalDensity.current
    val imeHeight = with(density) { WindowInsets.ime.getBottom(this).toDp() }
    // ModalBottomSheet remains edge-to-edge while the IME is shown. Bound the
    // actual sheet height to the unobscured region so the pinned footer never
    // lands behind the keyboard even when the window itself is not resized.
    val maxHeight = minOf(screenHeight * .84f, (screenHeight - imeHeight).coerceAtLeast(320.dp))
    val tokens = LocalTokens.current
    ModalBottomSheet(
        onDismissRequest = { if (dismissEnabled) onDismiss() },
        shape = RoundedCornerShape(topStart = tokens.radii.xl, topEnd = tokens.radii.xl),
        containerColor = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurface,
        scrimColor = MaterialTheme.colorScheme.background.copy(alpha = .62f),
        tonalElevation = 18.dp,
        dragHandle = { SheetHandle() },
        contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
        modifier = modifier.semantics { testTagsAsResourceId = true },
    ) {
        Column(
            Modifier.fillMaxWidth().height(maxHeight)
                .navigationBarsPadding()
                .semantics { paneTitle = paneName },
        ) {
            // Keep actions outside and before the scroll region. ModalBottomSheet
            // can remain edge-to-edge on some IMEs even when insets report zero;
            // top-pinning guarantees the action bar stays in the unobscured pane.
            if (footer != null) {
                Column(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = tokens.space.md),
                    content = footer,
                )
            }
            Column(
                Modifier.fillMaxWidth().weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, end = 16.dp, bottom = tokens.space.xl),
                verticalArrangement = Arrangement.spacedBy(tokens.space.md),
                content = content,
            )
        }
    }
}

@Composable
private fun SheetHandle() {
    Box(
        Modifier.padding(top = 8.dp, bottom = 14.dp)
            .width(42.dp).height(4.dp)
            .background(MaterialTheme.colorScheme.outline, RoundedCornerShape(999.dp))
            .testTag("calendar-sheet-handle"),
    )
}

@Composable
private fun SheetHeader(title: String, onDismiss: () -> Unit, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            title,
            style = MaterialTheme.typography.headlineSmall.copy(fontFamily = Fraunces),
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        TextButton(
            onClick = onDismiss,
            enabled = enabled,
            modifier = Modifier.size(48.dp).semantics { contentDescription = "Close sheet" }
                .testTag("calendar-sheet-close"),
        ) {
            Text("×", style = MaterialTheme.typography.headlineSmall)
        }
    }
}

@Composable
private fun MetadataDivider(rows: List<Pair<String, String>>) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        rows.forEach { (label, value) ->
            Row(Modifier.fillMaxWidth()) {
                Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(92.dp))
                Text(value, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun OverlayError(error: CalendarMutationError?) {
    if (error == null) return
    val text = error.presentationMessage()
    Text(
        text,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Assertive }
            .testTag("calendar-overlay-error"),
    )
}

@Composable
private fun ConnectionRequiredNotice(message: String) {
    Text(
        message,
        color = MaterialTheme.colorScheme.tertiary,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("calendar-connection-required"),
    )
}

@Composable
private fun ConflictPanel(
    conflict: CalendarConflictReviewState,
    draft: CalendarMutationDraft,
    onReread: () -> Unit,
    onReview: (CalendarMutationDraft) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("This event changed since you opened it.", fontWeight = FontWeight.SemiBold)
        Text("Reread the latest version, review your draft, then save again.")
        if (conflict.authoritativeEvent == null) {
            SecondaryAction(
                if (conflict.rereadInFlight) "Rereading…" else "Reread latest event",
                onReread,
                Modifier.fillMaxWidth().testTag("calendar-conflict-reread"),
                enabled = !conflict.rereadInFlight,
            )
        } else if (!conflict.reviewed) {
            PrimaryAction(
                "Review and rebase draft",
                { onReview(draft) },
                true,
                Modifier.fillMaxWidth().testTag("calendar-conflict-review"),
            )
        } else Text("Latest version reviewed. You can save again.", color = MaterialTheme.colorScheme.secondary)
    }
}

@Composable
private fun RecurrenceScopeChoices(
    scopes: List<CalendarMutationScope>,
    selected: CalendarMutationScope?,
    enabled: Boolean,
    onSelect: (CalendarMutationScope) -> Unit,
) {
    SectionLabel("Apply change to")
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        scopes.forEach { scope ->
            FilterChip(
                selected = selected == scope,
                onClick = { onSelect(scope) },
                enabled = enabled,
                label = { Text(scope.accessibleLabel()) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .testTag("calendar-scope-${scope.wire}"),
            )
        }
    }
}

@Composable
private fun RecurrenceFields(
    draft: CalendarMutationDraft,
    enabled: Boolean,
    onChange: (CalendarMutationDraft) -> Unit,
) {
    SectionLabel("Recurrence")
    val recurrence = draft.recurrence
    LabeledSwitch("Repeats", recurrence != null, enabled) { repeats ->
        onChange(draft.copy(recurrence = if (repeats) StructuredRecurrence(RecurrenceFrequency.WEEKLY) else null))
    }
    if (recurrence == null) return
    EnumOptions(RecurrenceFrequency.entries, recurrence.frequency, { it.displayName() }, enabled) {
        onChange(draft.copy(recurrence = recurrence.copy(frequency = it)))
    }
    OutlinedTextField(
        value = (recurrence.interval ?: 1).toString(),
        onValueChange = { value -> value.toIntOrNull()?.takeIf { it > 0 }?.let { onChange(draft.copy(recurrence = recurrence.copy(interval = it))) } },
        label = { Text("Repeat every") },
        supportingText = { Text("Interval") },
        enabled = enabled,
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    if (recurrence.frequency == RecurrenceFrequency.WEEKLY) {
        SectionLabel("Weekdays")
        Weekday.entries.forEach { day ->
            val selected = day in recurrence.weekdays.orEmpty()
            Row(
                Modifier.fillMaxWidth().heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(selected, { checked ->
                    val days = recurrence.weekdays.orEmpty().toMutableList().apply {
                        if (checked) add(day) else remove(day)
                    }.distinct()
                    onChange(draft.copy(recurrence = recurrence.copy(weekdays = days.takeIf(List<*>::isNotEmpty))))
                }, enabled = enabled)
                Text(day.displayName())
            }
        }
    }
    OutlinedTextField(
        value = recurrence.count?.toString().orEmpty(),
        onValueChange = { value ->
            if (value.isBlank() || value.toIntOrNull()?.let { it > 0 } == true) {
                onChange(draft.copy(recurrence = recurrence.copy(count = value.toIntOrNull(), until = null)))
            }
        },
        label = { Text("Number of occurrences (optional)") },
        enabled = enabled,
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    DateButton(
        label = "Repeat until (optional)",
        value = recurrence.until,
        enabled = enabled && recurrence.count == null,
        onDate = { onChange(draft.copy(recurrence = recurrence.copy(until = it.toString(), count = null))) },
        onClear = { onChange(draft.copy(recurrence = recurrence.copy(until = null))) },
    )
}

@Composable
private fun DateTimeFields(
    draft: CalendarMutationDraft,
    enabled: Boolean,
    onChange: (CalendarMutationDraft) -> Unit,
) {
    val zone = runCatching { ZoneId.of(draft.inputTimeZoneId ?: ZoneId.systemDefault().id) }.getOrDefault(ZoneId.systemDefault())
    if (draft.allDay) {
        DateButton("Start date", draft.start, enabled) { start ->
            onChange(draft.withAllDayPickerValues(start, draft.end?.parseDateOrNull()))
        }
        DateButton(
            "End date (optional)",
            draft.end,
            enabled,
            onDate = { end -> onChange(draft.withAllDayPickerValues(draft.start.parseDateOrNull() ?: end, end)) },
            onClear = { onChange(draft.copy(end = null)) },
        )
    } else {
        val start = draft.start.parseDateTimeOrNull(zone) ?: LocalDateTime.now(zone).withSecond(0).withNano(0)
        val end = draft.end?.parseDateTimeOrNull(zone)
        DateButton("Start date", start.toLocalDate().toString(), enabled) { date ->
            onChange(draft.withTimedPickerValues(LocalDateTime.of(date, start.toLocalTime()), end, zone))
        }
        TimeButton("Start time", start, enabled) { time ->
            onChange(draft.withTimedPickerValues(LocalDateTime.of(start.toLocalDate(), time.toLocalTime()), end, zone))
        }
        DateButton("End date", (end ?: start).toLocalDate().toString(), enabled) { date ->
            val value = LocalDateTime.of(date, (end ?: start.plusHours(1)).toLocalTime())
            onChange(draft.withTimedPickerValues(start, value, zone))
        }
        TimeButton("End time", end ?: start.plusHours(1), enabled) { time ->
            val value = LocalDateTime.of((end ?: start).toLocalDate(), time.toLocalTime())
            onChange(draft.withTimedPickerValues(start, value, zone))
        }
        if (draft.end != null) {
            TextButton(
                onClick = { onChange(draft.copy(end = null)) },
                enabled = enabled,
                modifier = Modifier.heightIn(min = 44.dp),
            ) { Text("Clear end time") }
        }
        Text("Time zone: ${zone.id}", style = MaterialTheme.typography.bodySmall.copy(fontFamily = JetBrainsMono), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DateButton(
    label: String,
    value: String?,
    enabled: Boolean,
    onClear: (() -> Unit)? = null,
    onDate: (LocalDate) -> Unit,
) {
    val context = LocalContext.current
    val initial = value?.parseDateOrNull() ?: LocalDate.now()
    Column {
        OutlinedButton(
            onClick = {
                DatePickerDialog(context, { _, year, month, day -> onDate(LocalDate.of(year, month + 1, day)) }, initial.year, initial.monthValue - 1, initial.dayOfMonth).show()
            },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .testTag(calendarEditorControlTag(label)),
        ) {
            Text("$label: ${value ?: "Not set"}", maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (value != null && onClear != null) {
            TextButton(onClick = onClear, enabled = enabled, modifier = Modifier.heightIn(min = 44.dp)) {
                Text("Clear $label")
            }
        }
    }
}

@Composable
private fun TimeButton(label: String, value: LocalDateTime, enabled: Boolean, onTime: (LocalDateTime) -> Unit) {
    val context = LocalContext.current
    OutlinedButton(
        onClick = {
            TimePickerDialog(context, { _, hour, minute -> onTime(value.withHour(hour).withMinute(minute)) }, value.hour, value.minute, false).show()
        },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .testTag(calendarEditorControlTag(label)),
    ) { Text("$label: ${value.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))}") }
}

@Composable
private fun LabeledSwitch(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .testTag(calendarEditorControlTag(label)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked, onChange, enabled = enabled)
    }
}

private fun calendarEditorControlTag(label: String): String = when (label) {
    "All-day event" -> "calendar-editor-all-day"
    "Start date" -> "calendar-editor-start-date"
    "Start time" -> "calendar-editor-start-time"
    "End date", "End date (optional)" -> "calendar-editor-end-date"
    "End time" -> "calendar-editor-end-time"
    "Repeats" -> "calendar-editor-recurrence"
    "Repeat until (optional)" -> "calendar-editor-recurrence-until"
    else -> "calendar-editor-${calendarTagToken(label)}"
}

@Composable
private fun SectionLabel(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun <T> EnumOptions(values: List<T>, selected: T, label: (T) -> String, enabled: Boolean, onSelect: (T) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        values.forEach { value ->
            FilterChip(
                selected = value == selected,
                onClick = { onSelect(value) },
                enabled = enabled,
                label = { Text(label(value)) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp),
            )
        }
    }
}

@Composable
private fun SheetActionRow(content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

@Composable
private fun PrimaryAction(text: String, onClick: () -> Unit, enabled: Boolean, modifier: Modifier, loading: Boolean = false) {
    val interactions = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp).pressScale(interactions),
        enabled = enabled,
        interactionSource = interactions,
    ) {
        if (loading) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
        Text(text)
    }
}

@Composable
private fun SecondaryAction(text: String, onClick: () -> Unit, modifier: Modifier, enabled: Boolean = true) {
    val interactions = remember { MutableInteractionSource() }
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp).pressScale(interactions),
        enabled = enabled,
        interactionSource = interactions,
    ) { Text(text) }
}

@Composable
private fun DestructiveAction(text: String, onClick: () -> Unit, enabled: Boolean, modifier: Modifier, loading: Boolean) {
    val interactions = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = 48.dp).pressScale(interactions),
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
        interactionSource = interactions,
    ) {
        if (loading) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
        Text(text)
    }
}

@Composable
private fun Modifier.pressScale(interactions: MutableInteractionSource): Modifier {
    val pressed by interactions.collectIsPressedAsState()
    val reducedMotion = LocalCalendarReducedMotion.current
    val scale by animateFloatAsState(
        if (pressed) .98f else 1f,
        calendarOverlayPressAnimationSpec(reducedMotion, LocalTokens.current.motion.fastMs),
        label = "calendar press",
    )
    return graphicsLayer { scaleX = scale; scaleY = scale }
}

internal fun calendarOverlayPressAnimationSpec(
    reducedMotion: Boolean,
    fastMs: Int,
): FiniteAnimationSpec<Float> = if (reducedMotion) snap() else tween(fastMs)

private fun CalendarMutationDraft.convertAllDay(toAllDay: Boolean): CalendarMutationDraft {
    if (toAllDay == allDay) return this
    val zone = runCatching { ZoneId.of(inputTimeZoneId ?: ZoneId.systemDefault().id) }.getOrDefault(ZoneId.systemDefault())
    return if (toAllDay) {
        val startDate = start.parseDateTimeOrNull(zone)?.toLocalDate() ?: start.parseDateOrNull() ?: LocalDate.now(zone)
        val endDate = end?.parseDateTimeOrNull(zone)?.toLocalDate()
        withAllDayPickerValues(startDate, endDate)
    } else {
        val startDate = start.parseDateOrNull() ?: LocalDate.now(zone)
        val endDate = end?.parseDateOrNull()
        withTimedPickerValues(startDate.atTime(9, 0), endDate?.atTime(10, 0), zone)
    }
}

private fun String.parseDateOrNull(): LocalDate? = runCatching { LocalDate.parse(this) }.getOrNull()
private fun String.parseDateTimeOrNull(zone: ZoneId): LocalDateTime? =
    runCatching { OffsetDateTime.parse(this).atZoneSameInstant(zone).toLocalDateTime() }.getOrNull()

private fun formatOccurrenceTime(value: EffectiveOccurrence): String {
    val date = value.start.parseDateOrNull()
    if (date != null) return "${date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL))} · All day"
    return runCatching {
        val start = OffsetDateTime.parse(value.start)
        val end = value.end?.let(OffsetDateTime::parse)
        buildString {
            append(start.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL)))
            append(" · ")
            append(start.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)))
            end?.let { append("–"); append(it.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))) }
        }
    }.getOrDefault(value.start)
}

private fun CalendarScope.displayName() = when (this) {
    CalendarScope.PRIVATE -> "Private"
    CalendarScope.HOUSEHOLD -> "Household"
    CalendarScope.ALL -> "All calendars"
}
private fun Visibility.displayName() = when (this) { Visibility.EVERYONE -> "Everyone"; Visibility.ADULTS -> "Adults" }
private fun Importance.displayName() = name.lowercase().replaceFirstChar(Char::uppercase)
private fun RecurrenceFrequency.displayName() = name.lowercase().replaceFirstChar(Char::uppercase)
private fun Weekday.displayName() = name.lowercase().replaceFirstChar(Char::uppercase)
private fun StructuredRecurrence.displayName(): String = buildString {
    append(frequency.displayName())
    interval?.takeIf { it > 1 }?.let { append(" every $it intervals") }
    weekdays?.takeIf { it.isNotEmpty() }?.let { append(" on ${it.joinToString { day -> day.displayName() }}") }
    count?.let { append(" · $it times") }
    until?.let { append(" · until $it") }
}
