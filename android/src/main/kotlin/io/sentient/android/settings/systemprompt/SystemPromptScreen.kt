// ---------------------------------------------------------------------------
// SystemPromptScreen — System Prompt settings page (scaffold placeholder, P3a). A
// later page agent fills the mono editor / preview toggle + restore-default confirm
// (slow-save) using [SystemPromptViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.systemprompt

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun SystemPromptScreen(
    vm: SystemPromptViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "System Prompt",
        onBack = onBack,
        screenTestTag = "settings-system-prompt-screen",
        backTestTag = "settings-system-prompt-back",
        modifier = modifier,
    )
}
