// ---------------------------------------------------------------------------
// ToolsScreen — Tools settings page: per-MCP-server cards (master on/off Switch +
// expand to per-tool Allow/Ask/Deny/Off dropdowns), a "Gateway tools" card for
// native tools with no MCP server — most (skill tools) are per-person settable
// under the reserved NATIVE_TOOL_SERVER_KEY namespace, delegateTask stays
// role-governed/read-only — and a Hermes built-ins card (per-toolset toggles).
// SLOW save (restart copy) via the shared SettingsEditChrome.
//
// The four-state permission semantics (see ToolsViewModel's file header) live in
// ToolsViewModel; this screen resolves them into RowSelect inputs, reading
// `state.pendingPermissions` (a patch overlay, NOT the loaded profile's own stored
// permissions) through the shared effectiveToolPermission helper. A server's tool
// list stays visible whenever expanded regardless of the master Switch's current
// reading — there is no "server is off, tools hidden" placeholder, since a tool's
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
import io.sentient.mobilesdk.settings.McpCatalogEntry
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.McpToolView
import io.sentient.mobilesdk.settings.NATIVE_TOOL_SERVER_KEY
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.ToolPermissionPatchMap
import io.sentient.mobilesdk.settings.effectiveToolPermission

private const val HEAD_SUB =
    "Tools available to the assistant each cycle. Toggle a server or built-in group on/off, or " +
        "expand to set individual tools to Allow, Ask, Deny or Off. Changes apply after Save — " +
        "the agent restarts to pick them up."

private const val NATIVE_TOOLS_SUB =
    "Built into the gateway itself, not an MCP server. Most rows (skill tools) are governed " +
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
            onToggleServer = vm::toggleServer,
            onSetToolPermission = vm::setToolPermission,
            onToggleToolset = vm::toggleToolset,
        )
    }
}

@Composable
private fun ColumnScope.ToolsBody(
    state: ToolsUiState,
    onToggleServer: (String) -> Unit,
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
                    permissions = state.pendingPermissions,
                    // Read through the SAME function the ViewModel's toggle inverts, so the
                    // Switch and the write can never disagree about which way a tap goes.
                    masterOn = isServerOn(state.pendingPermissions, catalog, id),
                    controlsEnabled = enabled,
                    onToggleServer = { onToggleServer(id) },
                    onSetToolPermission = { toolName, permission -> onSetToolPermission(id, toolName, permission) },
                )
            }
        }
    }
    NativeToolsCard(
        catalog = catalog,
        permissions = state.pendingPermissions,
        controlsEnabled = enabled,
        onSetToolPermission = { toolName, permission ->
            onSetToolPermission(NATIVE_TOOL_SERVER_KEY, toolName, permission)
        },
    )
    HermesBuiltinsCard(
        catalog = catalog,
        enabledToolsets = state.pendingToolsets ?: original.tools.toolsets ?: emptyList(),
        controlsEnabled = enabled,
        onToggleToolset = onToggleToolset,
    )
}

@Composable
private fun McpServerSection(
    id: String,
    entry: McpCatalogEntry,
    permissions: ToolPermissionPatchMap,
    masterOn: Boolean,
    controlsEnabled: Boolean,
    onToggleServer: () -> Unit,
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
        description = entry.description,
        countLabel = count,
        open = open,
        checked = masterOn,
        controlsEnabled = controlsEnabled,
        onExpand = { open = !open },
        onToggle = onToggleServer,
        testTag = "settings-tools-server-$id",
    )
    if (open) {
        if (entry.tools.isEmpty()) {
            EmptyRow("No tools declared for this server.")
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

@Composable
private fun NativeToolsCard(
    catalog: McpCatalogView,
    permissions: ToolPermissionPatchMap,
    controlsEnabled: Boolean,
    onSetToolPermission: (String, ToolPermission) -> Unit,
) {
    val tools = catalog.nativeTools
    if (tools.isEmpty()) return
    SettingsCard(title = "Gateway tools", subtitle = NATIVE_TOOLS_SUB, testTag = "settings-tools-native") {
        tools.forEach { tool ->
            ToolPermissionRow(
                tool = tool,
                // Most native rows (skill tools) resolve their stored override under
                // the reserved NATIVE_TOOL_SERVER_KEY namespace — read pending edits
                // through effectiveToolPermission exactly like an MCP server's own
                // tool, never the catalog snapshot directly. Reading `tool.permission`
                // unconditionally here was the bug: it was safe only while every
                // native tool was settable: false, and silently ignored this
                // session's edits once skill_* tools became settable. delegateTask
                // (settable: false) has no stored address at all, so it always falls
                // back to its catalog-resolved snapshot regardless — there is never a
                // pending edit under its own name to find.
                permission = effectiveToolPermission(permissions, NATIVE_TOOL_SERVER_KEY, tool),
                controlsEnabled = controlsEnabled,
                onSelect = { permission ->
                    // RowSelect already renders delegateTask fully non-interactive
                    // (enabled = controlsEnabled && tool.settable), but this guard
                    // stays explicit: a serverless native tool (serverName: null) has
                    // no resolver branch that would ever read a write back, so writing
                    // one anyway would be silently discarded, not merely redundant.
                    if (tool.settable) onSetToolPermission(tool.name, permission)
                },
                testTag = "settings-tools-native-${tool.name}",
            )
        }
    }
}

/**
 * One tool's four-state permission control: the tool name + description on the
 * left, a RowSelect (Allow/Ask/Deny/Off) on the right. Shared by
 * [McpServerSection]'s expanded per-tool list and [NativeToolsCard] — identical
 * rendering regardless of which catalog array (McpCatalogEntry.tools or
 * McpCatalogView.nativeTools) a tool came from. [McpToolView.settable] is what
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
            SettingsCard(title = "MCP servers") { EmptyRow("No tools configured.") }
        }
    }
}
