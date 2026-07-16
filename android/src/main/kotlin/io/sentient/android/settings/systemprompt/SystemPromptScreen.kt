// ---------------------------------------------------------------------------
// SystemPromptScreen — System Prompt (Soul.md) page: edit/preview segmented, a
// monospace editor over the soul content, and a Restore-default button (confirm
// dialog loads the canonical template into the draft). SLOW save (restart copy).
// Preview renders the draft as plain text (no markdown dependency). Copy mirrors
// webui system-prompt-pane; sidebar label "System Prompt" wins over pane "Persona".
// ---------------------------------------------------------------------------
package io.sentient.android.settings.systemprompt

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.DangerButton
import io.sentient.android.settings.components.MonoEditor
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val HEAD_SUB =
    "The base personality and behavior contract loaded into your assistant at boot. " +
        "Edits live in Soul.md and are baked into the next conversation chain after Apply."

private val VIEW_OPTIONS = listOf(SegmentOption("edit", "Edit"), SegmentOption("preview", "Preview"))

@Composable
fun SystemPromptScreen(
    vm: SystemPromptViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    SystemPromptScaffold(state = state, onBack = onBack, onSave = vm::save, modifier = modifier) {
        SystemPromptBody(state = state, onDraft = vm::setDraft, onRestoreDefault = vm::restoreDefault)
    }
}

@Composable
private fun ColumnScope.SystemPromptBody(
    state: SystemPromptUiState,
    onDraft: (String) -> Unit,
    onRestoreDefault: () -> Unit,
) {
    val draft = state.draft
    if (draft == null) {
        LoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    var view by remember { mutableStateOf("edit") }
    var confirmRestore by remember { mutableStateOf(false) }
    val enabled = !state.applyActive
    PaneSub(HEAD_SUB)
    SettingsCard(title = "Soul.md", subtitle = "Markdown supported. Restart required after Save.") {
        val tokens = LocalTokens.current
        Column(modifier = Modifier.padding(horizontal = tokens.space.lg), verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            RowSegmented(
                options = VIEW_OPTIONS,
                selected = view,
                onSelect = { view = it },
                testTag = "settings-system-prompt-view",
            )
            if (view == "edit") {
                MonoEditor(
                    value = draft,
                    onValueChange = onDraft,
                    minLines = 14,
                    enabled = enabled,
                    testTag = "settings-system-prompt-editor",
                )
            } else {
                PreviewText(draft)
            }
            DangerButton(
                label = "Restore default",
                onClick = { confirmRestore = true },
                enabled = enabled,
                testTag = "settings-system-prompt-restore",
            )
        }
    }
    if (confirmRestore) {
        RestoreDefaultDialog(
            onConfirm = { confirmRestore = false; onRestoreDefault() },
            onDismiss = { confirmRestore = false },
        )
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
            .testTag("settings-system-prompt-preview"),
        color = Color(Colors.ink),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun RestoreDefaultDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Restore default Soul.md?") },
        text = { Text("This replaces your edits with the canonical template. Save afterwards to apply — you can still discard before saving.") },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("settings-system-prompt-restore-confirm")) {
                Text("Restore", color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ── Co-located page scaffold (see AudioScreen note) ──

@Composable
private fun SystemPromptScaffold(
    state: SystemPromptUiState,
    onBack: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    body: @Composable ColumnScope.() -> Unit,
) {
    val tokens = LocalTokens.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val attemptBack: () -> Unit = { if (state.dirty) confirmDiscard = true else onBack() }
    BackHandler(enabled = true, onBack = attemptBack)
    Column(modifier.fillMaxSize().safeDrawingPadding().testTag("settings-system-prompt-screen")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SettingsTopBar(
                title = "System Prompt",
                onBack = attemptBack,
                backTestTag = "settings-system-prompt-back",
                modifier = Modifier.weight(1f),
            )
            if (state.dirty) {
                TextButton(
                    onClick = onSave,
                    enabled = !state.applyActive,
                    modifier = Modifier.padding(end = tokens.space.sm).testTag("settings-system-prompt-save"),
                ) {
                    Text("Save", color = Color(Colors.accent), fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            ApplyNotice(state.saving, state.restarting, state.alreadyApplying, state.applyError)
            body()
        }
    }
    if (confirmDiscard) {
        DiscardDialog(
            onConfirm = { confirmDiscard = false; onBack() },
            onDismiss = { confirmDiscard = false },
        )
    }
}

@Composable
private fun PaneSub(text: String) {
    val tokens = LocalTokens.current
    Text(text, Modifier.padding(bottom = tokens.space.xs), color = Color(Colors.ink3), fontSize = tokens.type.sm)
}

@Composable
private fun ColumnScope.LoadStatus(loading: Boolean, error: String?) {
    val tokens = LocalTokens.current
    val text = when {
        error != null -> error
        loading -> "Loading…"
        else -> return
    }
    Text(text, Modifier.testTag("settings-load-status"), color = if (error != null) Color(Colors.stop) else Color(Colors.ink3), fontSize = tokens.type.sm)
}

@Composable
private fun ApplyNotice(saving: Boolean, restarting: Boolean, alreadyApplying: Boolean, applyError: String?) {
    val tokens = LocalTokens.current
    val (msg, tone) = when {
        applyError != null -> applyError to Colors.stop
        alreadyApplying -> "Another change is already applying. Try again in a moment." to Colors.warn
        restarting -> "Applying — assistant restarting…" to Colors.accent
        saving -> "Applying…" to Colors.accent
        else -> return
    }
    Text(
        text = msg,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(Color(Colors.bgElev))
            .border(1.dp, Color(tone), RoundedCornerShape(tokens.radii.sm))
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm)
            .testTag("settings-apply-notice"),
        color = Color(tone),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun DiscardDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Discard changes?") },
        text = { Text("Your unsaved edits will be lost.") },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("settings-discard-confirm")) {
                Text("Discard", color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep editing") } },
    )
}

@Preview
@Composable
private fun SystemPromptScreenPreview() {
    SentientTheme {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            SettingsTopBar(title = "System Prompt", onBack = {})
            Column(Modifier.padding(16.dp)) {
                PaneSub(HEAD_SUB)
                SettingsCard(title = "Soul.md", subtitle = "Markdown supported.") {
                    Column(Modifier.padding(horizontal = 16.dp)) {
                        MonoEditor(value = "# You are Sentient…", onValueChange = {}, minLines = 4)
                    }
                }
            }
        }
    }
}
