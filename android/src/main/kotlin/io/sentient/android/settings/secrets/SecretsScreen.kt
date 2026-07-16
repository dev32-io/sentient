// ---------------------------------------------------------------------------
// SecretsScreen — the Secrets (admin) settings page (Admin group). Per-provider
// masked key rows (OpenRouter / Ollama Cloud / Custom + base URL) showing presence
// only, "Set active" per row, and — after any save — an inline "restart to pick up
// the new key" notice with an "Apply now" button that fires the bare apply. State +
// callbacks come from [SecretsViewModel]; the key drafts live in SecretRow, never
// here. testTags: settings-secrets-screen/-back, settings-secrets-apply, plus the
// per-provider row tags from SecretRow.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.secrets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.LlmSecretsStatus
import io.sentient.mobilesdk.settings.SecretsStatus

private const val TITLE = "Secrets"

@Composable
fun SecretsScreen(
    vm: SecretsViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    SecretsContent(
        state = state,
        onBack = onBack,
        onStartEdit = vm::startEdit,
        onCancelEdit = vm::cancelEdit,
        onSaveKey = vm::saveKey,
        onSaveBaseUrl = vm::saveBaseUrl,
        onSetActive = vm::setActive,
        onApplyNow = vm::applyNow,
        modifier = modifier,
    )
}

@Composable
private fun SecretsContent(
    state: SecretsUiState,
    onBack: () -> Unit,
    onStartEdit: (String, SecretField) -> Unit,
    onCancelEdit: () -> Unit,
    onSaveKey: (String, String) -> Unit,
    onSaveBaseUrl: (String) -> Unit,
    onSetActive: (String) -> Unit,
    onApplyNow: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-secrets-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-secrets-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            val status = state.status
            if (status == null) {
                Text("Loading…", color = Color(Colors.ink3), fontSize = tokens.type.sm)
            } else {
                ProviderCard(status, state.editing, onStartEdit, onCancelEdit, onSaveKey, onSaveBaseUrl, onSetActive)
                RestartNotice(state.restartNeeded, state.applying, onApplyNow)
            }
            if (state.errorMessage != null) {
                Text(state.errorMessage, color = Color(Colors.stop), fontSize = tokens.type.sm)
            }
        }
    }
}

@Composable
private fun ProviderCard(
    status: SecretsStatus,
    editing: EditingTarget?,
    onStartEdit: (String, SecretField) -> Unit,
    onCancelEdit: () -> Unit,
    onSaveKey: (String, String) -> Unit,
    onSaveBaseUrl: (String) -> Unit,
    onSetActive: (String) -> Unit,
) {
    val llm: LlmSecretsStatus = status.llm
    SettingsCard(title = "Active keys", subtitle = "Encrypted at rest. Shared by the household gateway.") {
        SecretRow(
            label = "OpenRouter",
            hasKey = llm.openrouter.hasKey,
            isActive = llm.active == SecretProviders.OPENROUTER,
            editing = editing.matches(SecretProviders.OPENROUTER, SecretField.KEY),
            onSetActive = { onSetActive(SecretProviders.OPENROUTER) },
            onStartEdit = { onStartEdit(SecretProviders.OPENROUTER, SecretField.KEY) },
            onCancel = onCancelEdit,
            onSave = { onSaveKey(SecretProviders.OPENROUTER, it) },
            testTagBase = "settings-secrets-openrouter",
        )
        SecretRow(
            label = "Ollama Cloud",
            hasKey = llm.ollamaCloud.hasKey,
            isActive = llm.active == SecretProviders.OLLAMA_CLOUD,
            editing = editing.matches(SecretProviders.OLLAMA_CLOUD, SecretField.KEY),
            onSetActive = { onSetActive(SecretProviders.OLLAMA_CLOUD) },
            onStartEdit = { onStartEdit(SecretProviders.OLLAMA_CLOUD, SecretField.KEY) },
            onCancel = onCancelEdit,
            onSave = { onSaveKey(SecretProviders.OLLAMA_CLOUD, it) },
            testTagBase = "settings-secrets-ollama",
        )
        SecretRow(
            label = "Custom",
            hasKey = llm.custom.hasKey,
            isActive = llm.active == SecretProviders.CUSTOM,
            editing = editing.matches(SecretProviders.CUSTOM, SecretField.KEY),
            onSetActive = { onSetActive(SecretProviders.CUSTOM) },
            onStartEdit = { onStartEdit(SecretProviders.CUSTOM, SecretField.KEY) },
            onCancel = onCancelEdit,
            onSave = { onSaveKey(SecretProviders.CUSTOM, it) },
            testTagBase = "settings-secrets-custom",
        )
        BaseUrlRow(
            hasBaseUrl = llm.custom.hasBaseUrl,
            editing = editing.matches(SecretProviders.CUSTOM, SecretField.BASE_URL),
            onStartEdit = { onStartEdit(SecretProviders.CUSTOM, SecretField.BASE_URL) },
            onCancel = onCancelEdit,
            onSave = onSaveBaseUrl,
            testTagBase = "settings-secrets-custom",
        )
    }
}

@Composable
private fun RestartNotice(restartNeeded: Boolean, applying: ApplyState?, onApplyNow: () -> Unit) {
    if (!restartNeeded && applying == null) return
    val tokens = LocalTokens.current
    val message = when (applying) {
        ApplyState.Restarting -> "Applying — assistant restarting…"
        ApplyState.AlreadyApplying -> "Already applying — another change is in progress."
        is ApplyState.Failed -> "Apply failed. Try again."
        is ApplyState.Ready, null -> "Restart the assistant to pick up the new key."
        ApplyState.Idle, ApplyState.Saving -> "Restart the assistant to pick up the new key."
    }
    Column(
        modifier = Modifier.fillMaxWidth().testTag("settings-secrets-restart-notice"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Text(message, color = Color(Colors.warn), fontSize = tokens.type.sm)
        if (applying !is ApplyState.Restarting) {
            Button(onClick = onApplyNow, modifier = Modifier.testTag("settings-secrets-apply")) {
                Text(if (applying is ApplyState.Failed) "Retry" else "Apply now")
            }
        }
    }
}

private fun EditingTarget?.matches(provider: String, field: SecretField): Boolean =
    this != null && this.provider == provider && this.field == field

@Preview
@Composable
private fun SecretsScreenPreview() {
    SentientTheme {
        SecretsContent(
            state = SecretsUiState(
                status = SecretsStatus(
                    llm = LlmSecretsStatus(
                        active = SecretProviders.OPENROUTER,
                        openrouter = io.sentient.mobilesdk.settings.LlmProviderStatus(hasKey = true),
                    ),
                ),
                restartNeeded = true,
            ),
            onBack = {}, onStartEdit = { _, _ -> }, onCancelEdit = {}, onSaveKey = { _, _ -> },
            onSaveBaseUrl = {}, onSetActive = {}, onApplyNow = {},
        )
    }
}
