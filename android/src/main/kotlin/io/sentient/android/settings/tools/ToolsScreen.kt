// ---------------------------------------------------------------------------
// ToolsScreen — Tools settings page (scaffold placeholder, P3a). A later page agent
// fills the per-MCP-server + per-tool toggles and Hermes built-in toolset toggles
// (slow-save) using [ToolsViewModel]. [vm] is host-resolved.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.sentient.android.settings.components.SettingsStubScaffold

@Composable
fun ToolsScreen(
    vm: ToolsViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SettingsStubScaffold(
        title = "Tools",
        onBack = onBack,
        screenTestTag = "settings-tools-screen",
        backTestTag = "settings-tools-back",
        modifier = modifier,
    )
}
