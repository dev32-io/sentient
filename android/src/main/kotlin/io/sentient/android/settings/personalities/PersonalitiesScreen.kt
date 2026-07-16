// ---------------------------------------------------------------------------
// PersonalitiesScreen — Personalities settings page: a list of expandable cards
// (activate / delete / edit instructions) plus a create form (name + instructions;
// name is immutable after create). Each action is its own restart-on-write op with
// shared progress; the list refetches after Ready. Back with unsaved edits prompts
// discard. Copy mirrors webui personalities-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.personalities

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
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
import io.sentient.android.settings.components.ApplyProgress
import io.sentient.android.settings.components.MonoEditor
import io.sentient.android.settings.components.SettingsApplyNotice
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.Personality

private const val HEAD_SUB = "Switchable tone profiles. Activate one for the assistant to wear."
private val NAME_PATTERN = Regex("^[a-zA-Z0-9_-]{1,64}$")

@Composable
fun PersonalitiesScreen(
    vm: PersonalitiesViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val tokens = LocalTokens.current
    val editDrafts = remember { mutableStateMapOf<String, String>() }
    var openName by remember { mutableStateOf<String?>(null) }
    var newOpen by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var newBody by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<String?>(null) }
    var confirmDiscard by remember { mutableStateOf(false) }

    val editDirty = state.personalities.any { p -> editDrafts[p.name]?.let { it != p.body } ?: false }
    val dirty = editDirty || (newOpen && (newName.isNotBlank() || newBody.isNotBlank()))
    val attemptBack: () -> Unit = { if (dirty) confirmDiscard = true else onBack() }
    BackHandler(enabled = true, onBack = attemptBack)

    Column(modifier.fillMaxSize().safeDrawingPadding().testTag("settings-personalities-screen")) {
        SettingsTopBar(title = "Personalities", onBack = attemptBack, backTestTag = "settings-personalities-back")
        Column(
            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            SettingsApplyNotice(ApplyProgress(state.saving, state.restarting, state.alreadyApplying, state.applyError))
            Text(HEAD_SUB, color = Color(Colors.ink3), fontSize = tokens.type.sm)
            TextButton(onClick = { newOpen = !newOpen }, enabled = !state.busy, modifier = Modifier.testTag("settings-personalities-new")) {
                Text(if (newOpen) "Cancel" else "＋ New personality", color = Color(Colors.accent))
            }
            if (newOpen) {
                NewPersonalityForm(
                    name = newName,
                    body = newBody,
                    valid = NAME_PATTERN.matches(newName.trim()) && state.personalities.none { it.name == newName.trim() },
                    enabled = !state.busy,
                    onName = { newName = it },
                    onBody = { newBody = it },
                    onCreate = { vm.create(newName, newBody); newOpen = false; newName = ""; newBody = "" },
                )
            }
            if (state.personalities.isEmpty() && !state.loading) {
                Text("No personalities yet. Tap + New to add one.", color = Color(Colors.ink3), fontSize = tokens.type.sm)
            }
            state.personalities.forEach { p ->
                PersonalityCard(
                    personality = p,
                    isActive = p.name == state.activeName,
                    isOpen = openName == p.name,
                    draftBody = editDrafts[p.name] ?: p.body,
                    busy = state.busy,
                    onToggleOpen = { openName = if (openName == p.name) null else p.name },
                    onBody = { editDrafts[p.name] = it },
                    onSaveBody = { editDrafts[p.name]?.let { body -> vm.updateBody(p.name, body) } },
                    onActivate = { vm.activate(p.name) },
                    onDelete = { deleteTarget = p.name },
                )
            }
        }
    }

    deleteTarget?.let { target ->
        ConfirmDialog(
            title = "Delete \"$target\"?",
            body = "This personality will be removed. Your assistant restarts to apply.",
            confirmLabel = "Delete",
            onConfirm = { deleteTarget = null; vm.delete(target) },
            onDismiss = { deleteTarget = null },
        )
    }
    if (confirmDiscard) {
        ConfirmDialog(
            title = "Discard changes?",
            body = "Your unsaved edits will be lost.",
            confirmLabel = "Discard",
            onConfirm = { confirmDiscard = false; onBack() },
            onDismiss = { confirmDiscard = false },
        )
    }
}

@Composable
private fun PersonalityCard(
    personality: Personality,
    isActive: Boolean,
    isOpen: Boolean,
    draftBody: String,
    busy: Boolean,
    onToggleOpen: () -> Unit,
    onBody: (String) -> Unit,
    onSaveBody: () -> Unit,
    onActivate: () -> Unit,
    onDelete: () -> Unit,
) {
    val tokens = LocalTokens.current
    val bodyDirty = draftBody != personality.body
    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(tokens.radii.md)).background(Color(Colors.paper))
            .border(1.dp, if (isActive) Color(Colors.accent) else Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.md))
            .testTag("settings-personality-${personality.name}"),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            Row(modifier = Modifier.weight(1f).clickable(onClick = onToggleOpen), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                Text(if (isOpen) "⌄" else "›", color = Color(Colors.ink3), fontSize = tokens.type.base)
                Text(personality.name, color = Color(Colors.ink), fontSize = tokens.type.base, fontWeight = FontWeight.Medium)
                if (isActive) Text("active", color = Color(Colors.accent), fontSize = tokens.type.xs)
            }
            if (!isActive) {
                TextButton(onClick = onActivate, enabled = !busy, modifier = Modifier.testTag("settings-personality-activate-${personality.name}")) {
                    Text("Activate", color = Color(Colors.accent), fontSize = tokens.type.sm)
                }
            }
            TextButton(onClick = onDelete, enabled = !busy, modifier = Modifier.testTag("settings-personality-delete-${personality.name}")) {
                Text("Delete", color = Color(Colors.stop), fontSize = tokens.type.sm)
            }
        }
        if (isOpen) {
            Column(modifier = Modifier.padding(tokens.space.md), verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                MonoEditor(value = draftBody, onValueChange = onBody, minLines = 8, enabled = !busy, testTag = "settings-personality-body-${personality.name}")
                if (bodyDirty) {
                    TextButton(onClick = onSaveBody, enabled = !busy, modifier = Modifier.testTag("settings-personality-save-${personality.name}")) {
                        Text("Save changes", color = Color(Colors.accent), fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun NewPersonalityForm(
    name: String,
    body: String,
    valid: Boolean,
    enabled: Boolean,
    onName: (String) -> Unit,
    onBody: (String) -> Unit,
    onCreate: () -> Unit,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(tokens.radii.md)).background(Color(Colors.paper))
            .border(1.dp, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.md)).padding(tokens.space.md),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            enabled = enabled,
            singleLine = true,
            label = { Text("Name") },
            placeholder = { Text("e.g. friendly, terse, scientist") },
            modifier = Modifier.fillMaxWidth().testTag("settings-personality-new-name"),
        )
        MonoEditor(
            value = body,
            onValueChange = onBody,
            minLines = 8,
            placeholder = "System-prompt-style instructions for this personality…",
            enabled = enabled,
            testTag = "settings-personality-new-body",
        )
        TextButton(onClick = onCreate, enabled = enabled && valid, modifier = Modifier.testTag("settings-personality-create")) {
            Text("Create", color = Color(Colors.accent), fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("settings-confirm")) {
                Text(confirmLabel, color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Preview
@Composable
private fun PersonalitiesScreenPreview() {
    SentientTheme {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            SettingsTopBar(title = "Personalities", onBack = {})
            PersonalityCard(
                personality = Personality("friendly", "Be warm and concise."),
                isActive = true,
                isOpen = false,
                draftBody = "Be warm and concise.",
                busy = false,
                onToggleOpen = {}, onBody = {}, onSaveBody = {}, onActivate = {}, onDelete = {},
            )
        }
    }
}
