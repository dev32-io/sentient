// ---------------------------------------------------------------------------
// DevicesScreen — Devices settings page (scaffold placeholder, P3a). A later page
// agent fills the Signal link/unlink card (deep-link + copy URI + status poll) using
// [DevicesViewModel] (which resolves SettingsComponent.devices). [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun DevicesScreen(
    vm: DevicesViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Devices",
        onBack = onBack,
        screenTestTag = "settings-devices-screen",
        backTestTag = "settings-devices-back",
        modifier = modifier,
    )
}
