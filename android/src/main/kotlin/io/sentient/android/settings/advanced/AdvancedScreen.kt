// ---------------------------------------------------------------------------
// AdvancedScreen — Advanced settings page (scaffold placeholder, P3a). A later page
// agent fills the reasoning select + compression slider + max-tokens slider +
// prompt-injection editor (slow-save) using [AdvancedViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.advanced

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun AdvancedScreen(
    vm: AdvancedViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Advanced",
        onBack = onBack,
        screenTestTag = "settings-advanced-screen",
        backTestTag = "settings-advanced-back",
        modifier = modifier,
    )
}
