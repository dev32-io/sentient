// ---------------------------------------------------------------------------
// AdvancedScreen — Advanced settings page: reasoning-effort select, compression
// threshold slider (0–1 / 0.05), max-tokens slider (128–8192 / 128), and a
// prompt-injection editor. SLOW save (restart copy). Copy mirrors webui advanced-pane.
// Header/apply-notice/discard helpers are co-located per page (see AudioScreen note).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.advanced

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
import io.sentient.android.settings.components.MonoEditor
import io.sentient.android.settings.components.RowSelect
import io.sentient.android.settings.components.RowSlider
import io.sentient.android.settings.components.SelectOption
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import kotlin.math.roundToInt

private const val HEAD_SUB = "Power-user knobs. Defaults are sensible — only touch if you know why."

private val REASONING_OPTIONS = listOf(
    SelectOption("none", "None · fastest"),
    SelectOption("minimal", "Minimal · default"),
    SelectOption("low", "Low"),
    SelectOption("medium", "Medium"),
    SelectOption("high", "High"),
    SelectOption("xhigh", "Extra high · slowest"),
)

@Composable
fun AdvancedScreen(
    vm: AdvancedViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    AdvancedEditScaffold(state = state, onBack = onBack, onSave = vm::save, modifier = modifier) {
        AdvancedBody(
            state = state,
            onReasoning = vm::setReasoning,
            onCompression = vm::setCompression,
            onMaxTokens = vm::setMaxTokens,
            onExtraPrompt = vm::setExtraPrompt,
        )
    }
}

@Composable
private fun ColumnScope.AdvancedBody(
    state: AdvancedUiState,
    onReasoning: (String) -> Unit,
    onCompression: (Double) -> Unit,
    onMaxTokens: (Int) -> Unit,
    onExtraPrompt: (String) -> Unit,
) {
    val draft = state.draft
    if (draft == null) {
        LoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.applyActive
    PaneSub(HEAD_SUB)
    SettingsCard(title = "Context") {
        RowSelect(
            label = "Reasoning",
            sub = "How hard the model thinks before answering. Higher = better, slower, pricier.",
            options = REASONING_OPTIONS,
            selectedValue = draft.advanced.reasoningEffort,
            onSelect = onReasoning,
            enabled = enabled,
            testTag = "settings-advanced-reasoning",
        )
        RowSlider(
            label = "Compression threshold",
            sub = "Summarize context when usage exceeds this fraction of the window.",
            value = draft.compression.threshold.toFloat(),
            onValueChange = { onCompression(it.toDouble()) },
            valueRange = 0f..1f,
            step = 0.05f,
            format = { "%.2f".format(it) },
            enabled = enabled,
            testTag = "settings-advanced-compression",
        )
        RowSlider(
            label = "Max tokens",
            sub = "Hard cap on assistant output per turn.",
            value = draft.advanced.maxTokens.toFloat(),
            onValueChange = { onMaxTokens(it.roundToInt()) },
            valueRange = 128f..8192f,
            step = 128f,
            format = { it.roundToInt().toString() },
            enabled = enabled,
            testTag = "settings-advanced-max-tokens",
        )
    }
    SettingsCard(
        title = "Prompt injection",
        subtitle = "Appended to every user message before it's sent. Use sparingly — counts against context.",
    ) {
        Column(modifier = Modifier.padding(horizontal = LocalTokens.current.space.lg)) {
            MonoEditor(
                value = draft.advanced.extraSystemPrompt,
                onValueChange = onExtraPrompt,
                minLines = 4,
                placeholder = "Optional extra instructions…",
                enabled = enabled,
                testTag = "settings-advanced-extra-prompt",
            )
        }
    }
}

// ── Co-located page scaffold (see AudioScreen note) ──

@Composable
private fun AdvancedEditScaffold(
    state: AdvancedUiState,
    onBack: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    body: @Composable ColumnScope.() -> Unit,
) {
    val tokens = LocalTokens.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val attemptBack: () -> Unit = { if (state.dirty) confirmDiscard = true else onBack() }
    BackHandler(enabled = true, onBack = attemptBack)
    Column(modifier.fillMaxSize().safeDrawingPadding().testTag("settings-advanced-screen")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SettingsTopBar(
                title = "Advanced",
                onBack = attemptBack,
                backTestTag = "settings-advanced-back",
                modifier = Modifier.weight(1f),
            )
            if (state.dirty) {
                TextButton(
                    onClick = onSave,
                    enabled = !state.applyActive,
                    modifier = Modifier.padding(end = tokens.space.sm).testTag("settings-advanced-save"),
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
private fun AdvancedScreenPreview() {
    SentientTheme {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            SettingsTopBar(title = "Advanced", onBack = {})
            Column(Modifier.padding(16.dp)) {
                PaneSub(HEAD_SUB)
                SettingsCard(title = "Context") {
                    RowSelect(
                        label = "Reasoning",
                        options = REASONING_OPTIONS,
                        selectedValue = "minimal",
                        onSelect = {},
                    )
                }
            }
        }
    }
}
