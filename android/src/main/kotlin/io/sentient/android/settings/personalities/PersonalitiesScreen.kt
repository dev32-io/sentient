// ---------------------------------------------------------------------------
// PersonalitiesScreen — Personalities settings page (scaffold placeholder, P3a). A
// later page agent fills the expandable cards (activate / delete / create) using
// [PersonalitiesViewModel]; the route + host wiring already exist. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.personalities

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun PersonalitiesScreen(
    vm: PersonalitiesViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Personalities",
        onBack = onBack,
        screenTestTag = "settings-personalities-screen",
        backTestTag = "settings-personalities-back",
        modifier = modifier,
    )
}
