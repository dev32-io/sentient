// ---------------------------------------------------------------------------
// ModelScreen — Model settings page (scaffold placeholder, P3a). A later page agent
// fills the provider segmented + model search + single-select card list (slow-save
// with restart progress) using [ModelViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.model

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun ModelScreen(
    vm: ModelViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Model",
        onBack = onBack,
        screenTestTag = "settings-model-screen",
        backTestTag = "settings-model-back",
        modifier = modifier,
    )
}
