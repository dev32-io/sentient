// ---------------------------------------------------------------------------
// ToolsScreen — Tools settings page: per-MCP-server cards (master toggle + expand to
// per-tool toggles) and a Hermes built-ins card (per-toolset toggles). SLOW save
// (restart copy) via the shared SettingsEditChrome. enabled-map semantics live in
// ToolsViewModel; this screen renders the derived active/total counts. Copy mirrors
// webui tools-pane.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.ApplyProgress
import io.sentient.android.settings.components.RowToggle
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsEditScaffold
import io.sentient.android.settings.components.SettingsLoadStatus
import io.sentient.android.settings.components.SettingsPaneSub
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.McpCatalogEntry
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.ToolPermissionMap
import io.sentient.mobilesdk.settings.effectiveToolPermission

private const val HEAD_SUB =
    "Tools available to the assistant each cycle. Toggle a server or built-in group on/off, or " +
        "expand to gate individual tools. Changes apply after Save — the agent restarts to pick them up."

@Composable
fun ToolsScreen(
    vm: ToolsViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.ui.collectAsStateWithLifecycle()
    SettingsEditScaffold(
        title = "Tools",
        screenTestTag = "settings-tools-screen",
        backTestTag = "settings-tools-back",
        saveTestTag = "settings-tools-save",
        dirty = state.dirty,
        apply = ApplyProgress(state.saving, state.restarting, state.alreadyApplying, state.applyError),
        onBack = onBack,
        onSave = vm::save,
        modifier = modifier,
    ) {
        ToolsBody(
            state = state,
            onToggleServer = vm::toggleServer,
            onToggleTool = vm::toggleTool,
            onToggleToolset = vm::toggleToolset,
        )
    }
}

@Composable
private fun ColumnScope.ToolsBody(
    state: ToolsUiState,
    onToggleServer: (String) -> Unit,
    onToggleTool: (String, String) -> Unit,
    onToggleToolset: (String) -> Unit,
) {
    val catalog = state.catalog
    val draft = state.draft
    if (catalog == null || draft == null) {
        SettingsLoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.applyActive
    SettingsPaneSub(HEAD_SUB)
    val serverIds = remember(catalog) { catalog.servers.keys.sorted() }
    SettingsCard(title = "MCP servers") {
        if (serverIds.isEmpty()) {
            EmptyRow("No tools configured. An admin can add them in gateway/config.yaml#mcp_catalog.")
        }
        serverIds.forEach { id ->
            val entry = catalog.servers[id] ?: return@forEach
            key(id) {
                McpServerSection(
                    id = id,
                    entry = entry,
                    permissions = draft.tools.permissions,
                    controlsEnabled = enabled,
                    onToggleServer = { onToggleServer(id) },
                    onToggleTool = { tool -> onToggleTool(id, tool) },
                )
            }
        }
    }
    HermesBuiltinsCard(
        catalog = catalog,
        enabledToolsets = draft.tools.toolsets ?: emptyList(),
        controlsEnabled = enabled,
        onToggleToolset = onToggleToolset,
    )
}

@Composable
private fun McpServerSection(
    id: String,
    entry: McpCatalogEntry,
    permissions: ToolPermissionMap?,
    controlsEnabled: Boolean,
    onToggleServer: () -> Unit,
    onToggleTool: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val activeTools = entry.tools.filter { effectiveToolPermission(permissions, id, it) != ToolPermission.OFF }
    val isEnabled = activeTools.isNotEmpty()
    val count = if (isEnabled) "${activeTools.size}/${entry.tools.size} tools" else "off"
    SectionHeaderRow(
        title = id,
        description = entry.description,
        countLabel = count,
        open = open,
        checked = isEnabled,
        controlsEnabled = controlsEnabled,
        onExpand = { open = !open },
        onToggle = onToggleServer,
        testTag = "settings-tools-server-$id",
    )
    if (open && isEnabled) {
        entry.tools.forEach { tool ->
            RowToggle(
                label = tool.name,
                sub = tool.description.ifBlank { null },
                checked = tool in activeTools,
                onCheckedChange = { onToggleTool(tool.name) },
                enabled = controlsEnabled,
                testTag = "settings-tools-tool-$id-${tool.name}",
            )
        }
    } else if (open) {
        EmptyRow("Server is off. Toggle on to enable and configure individual tools.")
    }
}

@Composable
private fun HermesBuiltinsCard(
    catalog: McpCatalogView,
    enabledToolsets: List<String>,
    controlsEnabled: Boolean,
    onToggleToolset: (String) -> Unit,
) {
    var open by remember { mutableStateOf(true) }
    val tools = remember(catalog) { catalog.hermesBuiltins.sortedWith(compareBy({ it.toolset }, { it.name })) }
    val active = tools.count { it.toolset in enabledToolsets }
    SettingsCard(title = "Hermes built-in tools") {
        SectionHeaderRow(
            title = "hermes",
            description = "Tools that run inside Hermes (memory, todo, web, browser…). Toggles operate on toolset groups.",
            countLabel = "$active/${tools.size} tools",
            open = open,
            checked = null,
            controlsEnabled = controlsEnabled,
            onExpand = { open = !open },
            onToggle = {},
            testTag = "settings-tools-hermes",
        )
        if (open) {
            tools.forEach { tool ->
                RowToggle(
                    label = tool.name,
                    sub = tool.description.ifBlank { tool.toolset },
                    checked = tool.toolset in enabledToolsets,
                    onCheckedChange = { onToggleToolset(tool.toolset) },
                    enabled = controlsEnabled,
                    testTag = "settings-tools-builtin-${tool.name}",
                )
            }
        }
    }
}

@Composable
private fun SectionHeaderRow(
    title: String,
    description: String?,
    countLabel: String,
    open: Boolean,
    checked: Boolean?,
    controlsEnabled: Boolean,
    onExpand: () -> Unit,
    onToggle: () -> Unit,
    testTag: String,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm).testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Row(
            modifier = Modifier.weight(1f).clickable(onClick = onExpand),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            Text(if (open) "⌄" else "›", color = Color(Colors.ink3), fontSize = tokens.type.base)
            Column(modifier = Modifier.weight(1f)) {
                Text(title, color = Color(Colors.ink), fontFamily = JetBrainsMono, fontSize = tokens.type.sm)
                if (description != null) {
                    Text(description, color = Color(Colors.ink3), fontSize = tokens.type.xs)
                }
            }
        }
        Text(countLabel, color = Color(Colors.ink3), fontSize = tokens.type.xs)
        if (checked != null) {
            Switch(
                checked = checked,
                onCheckedChange = { onToggle() },
                enabled = controlsEnabled,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color(Colors.paper),
                    checkedTrackColor = Color(Colors.accent),
                    uncheckedTrackColor = Color(Colors.bgSunk),
                ),
            )
        }
    }
}

@Composable
private fun EmptyRow(text: String) {
    val tokens = LocalTokens.current
    Text(
        text = text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
        color = Color(Colors.ink3),
        fontSize = tokens.type.xs,
    )
}

@Preview
@Composable
private fun ToolsScreenPreview() {
    SentientTheme {
        Column {
            SettingsTopBar(title = "Tools", onBack = {})
            SettingsCard(title = "MCP servers") { EmptyRow("No tools configured.") }
        }
    }
}
