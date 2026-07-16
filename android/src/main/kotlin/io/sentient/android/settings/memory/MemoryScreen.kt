// ---------------------------------------------------------------------------
// MemoryScreen — Memory settings page: slot segmented (MEMORY.md / USER.md, lazy
// per-slot fetch), edit/preview segmented, a monospace editor hard-capped at the
// server `charLimit` with a live counter. SLOW save (restart copy) via the shared
// SettingsEditChrome — Save commits every dirty slot. Preview renders the draft as
// plain text (no markdown dependency). Copy mirrors webui memory-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.memory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.ApplyProgress
import io.sentient.android.settings.components.MonoEditor
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsEditScaffold
import io.sentient.android.settings.components.SettingsPaneSub
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.MemorySlot

private const val HEAD_SUB =
    "Persistent context Hermes carries between conversations. The agent writes and prunes this " +
        "autonomously; you can hand-edit. Save restarts your assistant so the next chain reads it."

private fun slotLabel(slot: MemorySlot): String = when (slot) {
    MemorySlot.MEMORY -> "MEMORY.md"
    MemorySlot.USER -> "USER.md"
}

private fun slotExplain(slot: MemorySlot): String = when (slot) {
    MemorySlot.MEMORY ->
        "Hermes-managed notes about the world: environment facts, conventions, things the agent " +
            "has learned. Hand-edit to seed or correct a fact."
    MemorySlot.USER ->
        "Your user profile: preferences, communication style, recurring expectations. Edit to seed " +
            "or correct what the assistant believes about you."
}

private val SLOT_OPTIONS = listOf(
    SegmentOption(MemorySlot.MEMORY.slug, "MEMORY.md"),
    SegmentOption(MemorySlot.USER.slug, "USER.md"),
)
private val VIEW_OPTIONS = listOf(SegmentOption("edit", "Edit"), SegmentOption("preview", "Preview"))

@Composable
fun MemoryScreen(
    vm: MemoryViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    SettingsEditScaffold(
        title = "Memory",
        screenTestTag = "settings-memory-screen",
        backTestTag = "settings-memory-back",
        saveTestTag = "settings-memory-save",
        dirty = state.dirty,
        apply = ApplyProgress(state.saving, state.restarting, state.alreadyApplying, state.applyError),
        onBack = onBack,
        onSave = vm::save,
        modifier = modifier,
    ) {
        MemoryBody(state = state, onSlot = vm::selectSlot, onDraft = vm::setDraft)
    }
}

@Composable
private fun ColumnScope.MemoryBody(
    state: MemoryUiState,
    onSlot: (MemorySlot) -> Unit,
    onDraft: (String) -> Unit,
) {
    val tokens = LocalTokens.current
    var view by remember(state.slot) { mutableStateOf("edit") }
    val enabled = !state.applyActive
    SettingsPaneSub(HEAD_SUB)
    RowSegmented(
        options = SLOT_OPTIONS,
        selected = state.slot.slug,
        onSelect = { slug -> MemorySlot.entries.firstOrNull { it.slug == slug }?.let(onSlot) },
        enabled = enabled,
        testTag = "settings-memory-slot",
    )
    SettingsCard(
        title = slotLabel(state.slot),
        subtitle = "${slotExplain(state.slot)} Hard-capped per Hermes spec. Restart required after Save.",
    ) {
        val draft = state.currentDraft
        Column(modifier = Modifier.padding(horizontal = tokens.space.lg), verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            if (draft == null) {
                Text(
                    text = state.loadError ?: "Loading…",
                    modifier = Modifier.testTag("settings-load-status"),
                    color = if (state.loadError != null) Color(Colors.stop) else Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
                return@Column
            }
            RowSegmented(options = VIEW_OPTIONS, selected = view, onSelect = { view = it }, testTag = "settings-memory-view")
            if (view == "edit") {
                MonoEditor(
                    value = draft,
                    onValueChange = onDraft,
                    maxLength = state.charLimit,
                    minLines = 12,
                    placeholder = "No ${slotLabel(state.slot)} yet — Hermes will write here over time, or seed it now.",
                    enabled = enabled,
                    testTag = "settings-memory-editor",
                )
            } else {
                PreviewText(draft)
            }
        }
    }
}

@Composable
private fun PreviewText(text: String) {
    val tokens = LocalTokens.current
    Text(
        text = text.ifBlank { "Nothing to preview." },
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(Color(Colors.bgElev))
            .border(1.dp, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.sm))
            .padding(tokens.space.md)
            .testTag("settings-memory-preview"),
        color = Color(Colors.ink),
        fontSize = tokens.type.sm,
    )
}

@Preview
@Composable
private fun MemoryScreenPreview() {
    SentientTheme {
        Column {
            SettingsTopBar(title = "Memory", onBack = {})
            RowSegmented(options = SLOT_OPTIONS, selected = "memory", onSelect = {})
        }
    }
}
