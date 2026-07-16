// ---------------------------------------------------------------------------
// MemoryScreen — Memory settings page (scaffold placeholder, P3a). A later page
// agent fills the slot segmented (MEMORY.md/USER.md) + editor/preview + char cap
// using [MemoryViewModel]; the route + host wiring already exist. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.memory

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun MemoryScreen(
    vm: MemoryViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Memory",
        onBack = onBack,
        screenTestTag = "settings-memory-screen",
        backTestTag = "settings-memory-back",
        modifier = modifier,
    )
}
