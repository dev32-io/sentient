// ---------------------------------------------------------------------------
// SecretsScreen — Secrets (admin) settings page (scaffold placeholder, P3a). A later
// page agent fills the per-provider masked key rows (update / set active / custom
// base-URL) using [SecretsViewModel] (SettingsComponent.admin). Reached only from the
// Admin group, itself gated on isAdmin. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.secrets

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun SecretsScreen(
    vm: SecretsViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Secrets",
        onBack = onBack,
        screenTestTag = "settings-secrets-screen",
        backTestTag = "settings-secrets-back",
        modifier = modifier,
    )
}
