// ---------------------------------------------------------------------------
// ModelScreen — Model settings page: provider segmented (from catalog providers),
// a search field, and a single-select model-card list (id + pricing + context).
// SLOW save (restart copy). The list is a LazyColumn (catalogs can be large), so the
// page composes the shared chrome pieces directly rather than the scroll scaffold;
// provider-browse + search are view-local. Copy mirrors webui model-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.model

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsApplyNotice
import io.sentient.android.settings.components.SettingsDiscardDialog
import io.sentient.android.settings.components.SettingsSaveTopBar
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.ModelEntry

private const val HEAD_SUB = "The LLM that powers Sentient's reasoning and tool calls."

@Composable
fun ModelScreen(
    vm: ModelViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val tokens = LocalTokens.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val attemptBack: () -> Unit = { if (state.dirty) confirmDiscard = true else onBack() }
    // Intercept back only while dirty (discard-confirm gate); clean → let the NavHost
    // handle the pop with the platform predictive-back animation. See SettingsEditChrome.
    BackHandler(enabled = state.dirty, onBack = attemptBack)

    Column(modifier.fillMaxSize().safeDrawingPadding().testTag("settings-model-screen")) {
        SettingsSaveTopBar(
            title = "Model",
            dirty = state.dirty,
            saveEnabled = !state.applyActive,
            backTestTag = "settings-model-back",
            saveTestTag = "settings-model-save",
            onBack = attemptBack,
            onSave = vm::save,
        )
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm)) {
            SettingsApplyNotice(ApplyProgress(state.saving, state.restarting, state.alreadyApplying, state.applyError))
        }
        ModelBody(state = state, onSelect = vm::selectModel)
    }
    if (confirmDiscard) {
        SettingsDiscardDialog(onConfirm = { confirmDiscard = false; onBack() }, onDismiss = { confirmDiscard = false })
    }
}

@Composable
private fun ModelBody(state: ModelUiState, onSelect: (ModelEntry) -> Unit) {
    val tokens = LocalTokens.current
    if (state.draft == null) {
        Text(
            text = state.loadError ?: "Loading…",
            modifier = Modifier.padding(tokens.space.lg).testTag("settings-load-status"),
            color = if (state.loadError != null) Color(Colors.stop) else Color(Colors.ink3),
            fontSize = tokens.type.sm,
        )
        return
    }
    val providers = remember(state.models) { state.models.map { it.provider }.distinct().sorted() }
    var providerOverride by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    val provider = providerOverride ?: state.draft.model.provider.takeIf { it in providers } ?: providers.firstOrNull() ?: ""
    val filtered = remember(state.models, provider, query) {
        state.models.filter { it.provider == provider && (query.isBlank() || it.id.contains(query, ignoreCase = true)) }
    }
    val enabled = !state.applyActive

    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(tokens.space.lg),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        item(key = "controls") {
            ModelControls(
                sub = HEAD_SUB,
                providers = providers,
                provider = provider,
                query = query,
                count = filtered.size,
                enabled = enabled,
                onProvider = { providerOverride = it },
                onQuery = { query = it },
            )
        }
        items(filtered, key = { it.provider + "/" + it.id }) { m ->
            ModelCard(entry = m, selected = m.id == state.selectedId, enabled = enabled, onClick = { onSelect(m) })
        }
        if (filtered.isEmpty()) {
            item(key = "empty") { Text("No models match.", color = Color(Colors.ink3), fontSize = tokens.type.sm) }
        }
    }
}

@Composable
private fun ModelControls(
    sub: String,
    providers: List<String>,
    provider: String,
    query: String,
    count: Int,
    enabled: Boolean,
    onProvider: (String) -> Unit,
    onQuery: (String) -> Unit,
) {
    val tokens = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        Text(sub, color = Color(Colors.ink3), fontSize = tokens.type.sm)
        if (providers.size > 1) {
            RowSegmented(
                options = providers.map { SegmentOption(it, providerLabel(it)) },
                selected = provider,
                onSelect = onProvider,
                enabled = enabled,
                testTag = "settings-model-provider",
            )
        }
        OutlinedTextField(
            value = query,
            onValueChange = onQuery,
            enabled = enabled,
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("settings-model-search"),
            placeholder = { Text("Search $count models…") },
        )
    }
}

@Composable
private fun ModelCard(entry: ModelEntry, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val tokens = LocalTokens.current
    val borderColor = if (selected) Color(Colors.accent) else Color(Colors.lineSoft)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.md))
            .background(Color(Colors.paper))
            .border(if (selected) 2.dp else 1.dp, borderColor, RoundedCornerShape(tokens.radii.md))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(tokens.space.md)
            .testTag("settings-model-card-${entry.id}"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            Text(
                text = entry.id,
                modifier = Modifier.weight(1f),
                color = Color(Colors.ink),
                fontFamily = JetBrainsMono,
                fontSize = tokens.type.sm,
            )
            if (selected) {
                Text("✓", color = Color(Colors.accent), fontWeight = FontWeight.Bold, fontSize = tokens.type.base)
            }
        }
        Text(
            text = "${priceText(entry)} · ${entry.contextLength / 1000}k context",
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
        )
    }
}

private fun providerLabel(id: String): String = when (id) {
    "ollama-cloud" -> "Ollama Cloud"
    "openrouter" -> "OpenRouter"
    "custom" -> "Custom"
    else -> id
}

private fun priceText(m: ModelEntry): String {
    val numeric = !m.pricingPer1mPrompt.isString
    val base = "$${m.pricingPer1mPrompt.content} / $${m.pricingPer1mCompletion.content}"
    return if (numeric) "$base /1M" else base
}

@Preview
@Composable
private fun ModelScreenPreview() {
    SentientTheme {
        Column {
            SettingsTopBar(title = "Model", onBack = {})
        }
    }
}
