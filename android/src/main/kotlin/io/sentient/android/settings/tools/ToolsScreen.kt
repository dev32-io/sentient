// ---------------------------------------------------------------------------
// ToolsScreen — Tools settings page: per-MCP-group cards (master on/off Switch +
// expand to per-tool Allow/Ask/Deny/Off dropdowns), a "Gateway tools" card for
// native tools with no MCP group — most (skill tools) are per-person settable
// under the reserved transport-specific metadata, without a separate native bucket
// role-governed/read-only — and a Hermes built-ins card (per-toolset toggles).
// SLOW save (restart copy) via the shared SettingsEditChrome.
//
// The four-state permission semantics (see ToolsViewModel's file header) live in
// ToolsViewModel; this screen resolves them into RowSelect inputs, reading
// `state.pendingPermissions` (a patch overlay, NOT the loaded profile's own stored
// permissions) through the shared effectiveToolPermission helper. A group's tool
// list stays visible whenever expanded regardless of the master Switch's current
// reading — there is no "group is off, tools hidden" placeholder, since a tool's
// own row can independently read anything from Allow to Off. Copy mirrors webui
// tools-pane.
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
import io.sentient.android.settings.components.RowSelect
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
import io.sentient.mobilesdk.settings.ProductToolGroupView
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.McpToolView
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.ToolPermissionPatchMap
import io.sentient.mobilesdk.settings.effectiveToolPermission

private const val HEAD_SUB =
    "Tools available to the assistant each cycle. Toggle a group or built-in group on/off, or " +
        "expand to set individual tools to Allow, Ask, Deny or Off. Changes apply after Save — " +
        "the agent restarts to pick them up."

private const val NATIVE_TOOLS_SUB =
    "Built into the gateway itself, not an MCP group. Most rows (skill tools) are governed " +
        "per-person like any other tool; delegateTask is governed by role only — no stored key " +
        "can address it yet."

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
            onToggleGroup = vm::toggleGroup,
            onSetToolPermission = vm::setToolPermission,
            onToggleToolset = vm::toggleToolset,
        )
    }
}

@Composable
private fun ColumnScope.ToolsBody(
    state: ToolsUiState,
    onToggleGroup: (String) -> Unit,
    onSetToolPermission: (String, String, ToolPermission) -> Unit,
    onToggleToolset: (String) -> Unit,
) {
    val catalog = state.catalog
    val original = state.original
    if (catalog == null || original == null) {
        SettingsLoadStatus(loading = state.loading, error = state.loadError)
        return
    }
    val enabled = !state.applyActive
    SettingsPaneSub(HEAD_SUB)
    val groupIds = remember(catalog) { catalog.groups.keys.sorted() }
    SettingsCard(title = "Product groups") {
        if (groupIds.isEmpty()) {
            EmptyRow("No tools configured. An admin can add them in gateway/config.yaml#mcp_catalog.")
        }
        groupIds.forEach { id ->
            val entry = catalog.groups[id] ?: return@forEach
            key(id) {
                ProductGroupSection(
                    id = id,
                    entry = entry,
                    permissions = state.pendingPermissions,
                    // Read through the SAME function the ViewModel's toggle inverts, so the
                    // Switch and the write can never disagree about which way a tap goes.
                    masterOn = isGroupOn(state.pendingPermissions, catalog, id),
                    controlsEnabled = enabled,
                    onToggleGroup = { onToggleGroup(id) },
                    onSetToolPermission = { toolName, permission -> onSetToolPermission(id, toolName, permission) },
                )
            }
        }
    }
    HermesBuiltinsCard(
        catalog = catalog,
        enabledToolsets = state.pendingToolsets ?: original.tools.toolsets ?: emptyList(),
        controlsEnabled = enabled,
        onToggleToolset = onToggleToolset,
    )
}

@Composable
private fun ProductGroupSection(
    id: String,
    entry: ProductToolGroupView,
    permissions: ToolPermissionPatchMap,
    masterOn: Boolean,
    controlsEnabled: Boolean,
    onToggleGroup: () -> Unit,
    onSetToolPermission: (String, ToolPermission) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    // Always "n/total tools", never a bare "off" — the count is a per-tool tally and the
    // Switch is the wildcard, and the two legitimately disagree between a master tap and
    // the save that resolves it. Collapsing the count to "off" made that disagreement read
    // as a contradiction. Mirrors webui tools-pane and the Hermes card below.
    val count = "${activeToolCount(permissions, id, entry)}/${entry.tools.size} tools"
    SectionHeaderRow(
        title = id,
        description = entry.description?.let { "$it · Default exposure: ${entry.defaultExposure.name.lowercase()}" }
            ?: "Default exposure: ${entry.defaultExposure.name.lowercase()}",
        countLabel = count,
        open = open,
        checked = masterOn,
        controlsEnabled = controlsEnabled,
        onExpand = { open = !open },
        onToggle = onToggleGroup,
        testTag = "settings-tools-group-$id",
    )
    if (open) {
        if (entry.tools.isEmpty()) {
            EmptyRow("No tools declared for this group.")
        } else {
            entry.tools.forEach { tool ->
                ToolPermissionRow(
                    tool = tool,
                    permission = effectiveToolPermission(permissions, id, tool),
                    controlsEnabled = controlsEnabled,
                    onSelect = { permission -> onSetToolPermission(tool.name, permission) },
                    testTag = "settings-tools-tool-$id-${tool.name}",
                )
            }
        }
    }
}

/**
 * One tool's four-state permission control: the tool name + description on the
 * left, a RowSelect (Allow/Ask/Deny/Off) on the right. Shared by
 * [ProductGroupSection]'s expanded per-tool list. [McpToolView.settable] is what
 * this row branches on to render read-only (a genuinely disabled,
 * non-interactive RowSelect — Compose's `clickable(enabled = false)` never
 * opens the menu) — never the tool's name.
 */
@Composable
private fun ToolPermissionRow(
    tool: McpToolView,
    permission: ToolPermission,
    controlsEnabled: Boolean,
    onSelect: (ToolPermission) -> Unit,
    testTag: String,
) {
    RowSelect(
        label = tool.name,
        sub = tool.description.ifBlank { null },
        options = toolPermissionSelectOptions,
        selectedValue = permission.wireValue,
        onSelect = { value -> toolPermissionFromWireValue(value)?.let(onSelect) },
        enabled = controlsEnabled && tool.settable,
        testTag = testTag,
    )
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
            SettingsCard(title = "MCP groups") { EmptyRow("No tools configured.") }
        }
    }
}
