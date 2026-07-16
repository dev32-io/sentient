// ---------------------------------------------------------------------------
// AdvancedScreen — Advanced settings page: reasoning-effort select, compression
// threshold slider (0–1 / 0.05), max-tokens slider (128–8192 / 128), and a
// prompt-injection editor. SLOW save (restart copy) via the shared SettingsEditChrome.
// Copy mirrors webui advanced-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.advanced

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.ApplyProgress
import io.sentient.android.settings.components.MonoEditor
import io.sentient.android.settings.components.RowSelect
import io.sentient.android.settings.components.RowSlider
import io.sentient.android.settings.components.SelectOption
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsEditScaffold
import io.sentient.android.settings.components.SettingsLoadStatus
import io.sentient.android.settings.components.SettingsPaneSub
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
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
    SettingsEditScaffold(
        title = "Advanced",
        screenTestTag = "settings-advanced-screen",
        backTestTag = "settings-advanced-back",
        saveTestTag = "settings-advanced-save",
        dirty = state.dirty,
        apply = ApplyProgress(state.saving, state.restarting, state.alreadyApplying, state.applyError),
        onBack = onBack,
        onSave = vm::save,
        modifier = modifier,
    ) {
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
        SettingsLoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.applyActive
    SettingsPaneSub(HEAD_SUB)
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

@Preview
@Composable
private fun AdvancedScreenPreview() {
    SentientTheme {
        Column {
            SettingsTopBar(title = "Advanced", onBack = {})
            SettingsCard(title = "Context") {
                RowSelect(label = "Reasoning", options = REASONING_OPTIONS, selectedValue = "minimal", onSelect = {})
            }
        }
    }
}
