// ---------------------------------------------------------------------------
// MembersScreen — Members (admin) settings page (scaffold placeholder, P3a). A later
// page agent fills the member list (promote/demote/delete) + add-user wizard (3-user
// cap) using [MembersViewModel] (SettingsComponent.admin). Reached only from the
// Admin group, itself gated on isAdmin. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun MembersScreen(
    vm: MembersViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Members",
        onBack = onBack,
        screenTestTag = "settings-members-screen",
        backTestTag = "settings-members-back",
        modifier = modifier,
    )
}
