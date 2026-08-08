// ---------------------------------------------------------------------------
// ToolsViewModel — Tools settings page. SLOW save: a full-profile PUT whose `tools`
// changed → PUT then apply (Hermes restart). Loads the profile + the MCP catalog.
//
// INTERIM two-state view over the per-tool permission model landed in
// 2026-08-07-tool-permissions task 7 (ProfileTools.permissions: server -> tool ->
// ToolPermission, replacing the retired enabled narrowing-array map). A tool/server
// counts as "on" iff its resolved permission is anything other than OFF — ALLOW, ASK
// and DENY all read as "on" here, collapsed onto the Switch this screen already has.
// The real four-state ALLOW/ASK/DENY/OFF dropdown, the settable-disabled row
// (delegateTask), and the nativeTools section are task 8's per-tool permission UI,
// not built here.
//
// SECURITY-CRITICAL: turning a tool/server "on" writes a CLEAR (`null`), NEVER a
// concrete ALLOW — a blanket ALLOW would silently escalate a confirm-tier tool's
// role-template ASK to auto-approved (the exact shipped-and-caught-on-web bug
// withServerMasterPermission exists to prevent; see ToolPermissionPatch.kt). Pending
// edits therefore live in `pendingPermissions` — a PATCH overlay (nullable leaves) —
// NEVER folded into a ProfileV1/ProfileTools, which is concrete-only BY DESIGN and
// structurally cannot hold a clear (see ProfileTools.permissions's doc comment).
// This mirrors iOS's existing draftEnabled/draftToolsets pattern for the identical
// reason: the stored KMP type cannot express what a pending edit here needs to. The
// overlay is merged onto the loaded profile's OWN stored permissions only at save
// time (mergeToolPermissionPatch), so an untouched server/tool is carried forward
// rather than dropped (see that function's doc comment for why a naive `base +
// overlay` at the server level would silently turn every untouched server off).
//
// Reads go through effectiveToolPermission (shared pure helper,
// io.sentient.mobilesdk.settings.ToolPermissionPatch.kt) so this screen's notion of
// "is this on" can never drift from what the ToolBroker actually resolves.
// profile.tools.toolsets: List<String>? — Hermes built-ins; a builtin row is ON iff
// its toolset is in toolsets. Toggling flips the whole toolset (unchanged).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.di.SettingsComponent
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.ApplyState
import io.sentient.mobiledata.usecase.settings.ProfileMutation
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.ProfileToolsPatch
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.ToolPermissionPatchMap
import io.sentient.mobilesdk.settings.effectiveToolPermission
import io.sentient.mobilesdk.settings.mergeToolPermissionPatch
import io.sentient.mobilesdk.settings.toPutBody
import io.sentient.mobilesdk.settings.withServerMasterPermission
import io.sentient.mobilesdk.settings.withToolPermission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Tools page state. `original` is server truth, never mutated locally. Pending
 * tool-permission edits live in `pendingPermissions` — see the file header for why
 * that can't be a `ProfileV1.tools.permissions` field instead.
 */
data class ToolsUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: ProfileV1? = null,
    val catalog: McpCatalogView? = null,
    val pendingPermissions: ToolPermissionPatchMap = emptyMap(),
    /** `null` = toolsets untouched this session (render `original`'s); a non-null list is a
     *  real pending edit even if it happens to equal the original value. */
    val pendingToolsets: List<String>? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    val dirty: Boolean
        get() = pendingPermissions.isNotEmpty() ||
            (pendingToolsets != null && pendingToolsets != (original?.tools?.toolsets ?: emptyList<String>()))

    val applyActive: Boolean get() = saving || restarting
}

class ToolsViewModel(private val component: SettingsComponent) : ViewModel() {
    private val log = createLogger("android", "settings", "tools-vm")

    private val _ui = MutableStateFlow(ToolsUiState())
    val ui: StateFlow<ToolsUiState> = _ui.asStateFlow()

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            _ui.update { it.copy(loading = true, loadError = null) }
            val profile = component.profileRepository.getProfile()
            if (profile !is SentientResult.Success) {
                val msg = (profile as? SentientResult.Failure)?.error?.userMessage ?: "Couldn't load profile."
                log.warn("load.profile.failed")
                _ui.update { it.copy(loading = false, loadError = msg) }
                return@launch
            }
            val catalog = when (val r = component.profileRepository.getMcpCatalog()) {
                is SentientResult.Success -> r.data
                else -> {
                    log.warn("load.catalog.degraded")
                    McpCatalogView()
                }
            }
            _ui.update {
                it.copy(
                    loading = false,
                    original = profile.data,
                    catalog = catalog,
                    pendingPermissions = emptyMap(),
                    pendingToolsets = null,
                )
            }
        }
    }

    /** Flips every role-governable tool on this server between "on" (CLEARED to each
     *  tool's own role-template answer) and an explicit OFF. NEVER a blanket ALLOW —
     *  see the file header and [serverToggleWrite]. */
    fun toggleServer(id: String) = editPermissions { pending, catalog ->
        val turnedOn = !isServerOn(pending, catalog, id)
        log.info("toggle-server", mapOf("id" to id, "on" to turnedOn))
        serverToggleWrite(pending, catalog, id)
    }

    /** Flips one tool between "on" (CLEARED to its own role-template answer) and an
     *  explicit OFF. NEVER a blanket ALLOW — see the file header and [toolToggleWrite]. */
    fun toggleTool(serverId: String, toolName: String) = editPermissions { pending, catalog ->
        toolToggleWrite(pending, catalog, serverId, toolName)
    }

    fun toggleToolset(toolset: String) {
        _ui.update { s ->
            val original = s.original ?: return@update s
            val current = s.pendingToolsets ?: original.tools.toolsets ?: emptyList()
            val next = if (toolset in current) current - toolset else current + toolset
            log.info("toggle-toolset", mapOf("toolset" to toolset, "on" to (toolset in next)))
            s.copy(pendingToolsets = next, alreadyApplying = false, applyError = null)
        }
    }

    private inline fun editPermissions(
        transform: (ToolPermissionPatchMap, McpCatalogView) -> ToolPermissionPatchMap,
    ) {
        _ui.update { s ->
            val catalog = s.catalog ?: return@update s
            s.copy(
                pendingPermissions = transform(s.pendingPermissions, catalog),
                alreadyApplying = false,
                applyError = null,
            )
        }
    }

    fun save() {
        val state = _ui.value
        val original = state.original ?: return
        if (!state.dirty || state.applyActive) return
        log.info(
            "save",
            mapOf(
                "changedServers" to state.pendingPermissions.size,
                "toolsetsChanged" to (state.pendingToolsets != null),
            ),
        )
        // mergeToolPermissionPatch carries forward every server/tool this session never
        // touched — sending pendingPermissions alone would drop them, and an absent server
        // in a non-empty stored table means "off forever" (ProfileTools.permissions's doc
        // comment), not "unchanged".
        val next = original.toPutBody().copy(
            tools = ProfileToolsPatch(
                permissions = mergeToolPermissionPatch(original.tools.permissions, state.pendingPermissions),
                toolsets = state.pendingToolsets ?: original.tools.toolsets,
            ),
        )
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutProfile(original, next)).collect { st ->
                _ui.update { it.foldApply(st) }
                if (st is ApplyState.Ready) refetch()
            }
        }
    }

    private suspend fun refetch() {
        when (val r = component.profileRepository.getProfile()) {
            is SentientResult.Success ->
                _ui.update { it.copy(original = r.data, pendingPermissions = emptyMap(), pendingToolsets = null) }
            is SentientResult.Failure -> log.warn("refetch.failed", mapOf("kind" to r.error.kind))
            is SentientResult.Loading -> Unit
        }
    }
}

/**
 * Pure, directly-testable (no ViewModel / SettingsComponent needed): whether [id]'s server
 * currently resolves "on" — any of its role-governable tools reads as anything other than
 * OFF — given [pending] edits layered over the catalog's resolved snapshot.
 */
internal fun isServerOn(pending: ToolPermissionPatchMap, catalog: McpCatalogView, id: String): Boolean {
    val entry = catalog.servers[id] ?: return false
    return entry.tools.any { effectiveToolPermission(pending, id, it) != ToolPermission.OFF }
}

/**
 * Pure, directly-testable: the master-control write for [id] given its CURRENT effective
 * state — off → on clears every named tool + the wildcard (`withServerMasterPermission`,
 * `turnOn = true`), on → off writes an explicit OFF everywhere. SECURITY-CRITICAL: the "on"
 * direction must NEVER be a concrete [ToolPermission.ALLOW] — see the file header.
 */
internal fun serverToggleWrite(
    pending: ToolPermissionPatchMap,
    catalog: McpCatalogView,
    id: String,
): ToolPermissionPatchMap {
    val entry = catalog.servers[id] ?: return pending
    val toolNames = entry.tools.map { it.name }
    return withServerMasterPermission(pending, id, toolNames, catalog.wildcardPermissionKey, turnOn = !isServerOn(pending, catalog, id))
}

/**
 * Pure, directly-testable: the single-tool write given its CURRENT effective state — off →
 * on CLEARS it (`withToolPermission(..., null)`), on → off writes an explicit OFF.
 * SECURITY-CRITICAL: the "on" direction must NEVER be a concrete [ToolPermission.ALLOW] —
 * see the file header.
 */
internal fun toolToggleWrite(
    pending: ToolPermissionPatchMap,
    catalog: McpCatalogView,
    serverId: String,
    toolName: String,
): ToolPermissionPatchMap {
    val entry = catalog.servers[serverId] ?: return pending
    val tool = entry.tools.find { it.name == toolName } ?: return pending
    val current = effectiveToolPermission(pending, serverId, tool)
    val next: ToolPermission? = if (current == ToolPermission.OFF) null else ToolPermission.OFF
    return withToolPermission(pending, serverId, toolName, next)
}

/** Fold one FSM transition into flat progress fields. */
internal fun ToolsUiState.foldApply(state: ApplyState): ToolsUiState = when (state) {
    ApplyState.Saving -> copy(saving = true, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.Restarting -> copy(saving = false, restarting = true)
    is ApplyState.Ready -> copy(saving = false, restarting = false, alreadyApplying = false, applyError = null)
    ApplyState.AlreadyApplying -> copy(saving = false, restarting = false, alreadyApplying = true)
    is ApplyState.Failed -> copy(saving = false, restarting = false, applyError = state.error.userMessage)
    ApplyState.Idle -> this
}
