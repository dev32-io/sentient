// ---------------------------------------------------------------------------
// AccountScreen — Account settings page (scaffold placeholder, P3a). A later page
// agent fills the display-name field + save and the change-PIN dialog using
// [AccountViewModel] (which resolves SettingsComponent.account). No sign-out here —
// logout stays a root-level danger row. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.account

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun AccountScreen(
    vm: AccountViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Account",
        onBack = onBack,
        screenTestTag = "settings-account-screen",
        backTestTag = "settings-account-back",
        modifier = modifier,
    )
}
