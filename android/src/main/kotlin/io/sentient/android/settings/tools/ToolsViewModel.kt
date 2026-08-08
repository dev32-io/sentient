// ---------------------------------------------------------------------------
// ToolsViewModel — Tools settings page. SLOW save: a full-profile PUT whose `tools`
// changed → PUT then apply (Hermes restart). Loads the profile + the MCP catalog;
// holds `original` + `draft`.
//
// INTERIM two-state view over the per-tool permission model landed in
// 2026-08-07-tool-permissions task 7 (ProfileTools.permissions: server -> tool ->
// ToolPermission, replacing the retired enabled narrowing-array map). A tool/server
// counts as "on" iff its resolved permission is anything other than OFF — ALLOW,
// ASK and DENY all read as "on" here, collapsed onto the Switch this screen already
// has. This screen writes ONLY concrete ALLOW/OFF (never ASK/DENY, never a clear) —
// the real four-state ALLOW/ASK/DENY/OFF dropdown, the wildcard master control, the
// settable-disabled row (delegateTask), and the nativeTools section are task 8's
// per-tool permission UI, not built here.
//
// Reads go through effectiveToolPermission/effectiveWildcardPermission (shared pure
// helpers, io.sentient.mobilesdk.settings.ToolPermissionPatch.kt) so this screen's
// notion of "is this on" can never drift from what the ToolBroker actually resolves.
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
import io.sentient.mobilesdk.settings.ProfileTools
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.effectiveToolPermission
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Tools page state. `original` is server truth; `draft` carries the pending tool config. */
data class ToolsUiState(
    val loading: Boolean = true,
    val loadError: String? = null,
    val original: ProfileV1? = null,
    val draft: ProfileV1? = null,
    val catalog: McpCatalogView? = null,
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val applyError: String? = null,
) {
    /** Compares with `permissions`/`toolsets` normalized (null → empty) — the server can
     *  round-trip a never-configured table as either null or {}/[] and those are
     *  semantically identical; comparing raw would spuriously flag a save as dirty on a
     *  profile the user never touched. */
    val dirty: Boolean
        get() = original != null && draft != null && draft.tools.normalized() != original.tools.normalized()

    val applyActive: Boolean get() = saving || restarting
}

private fun ProfileTools.normalized(): ProfileTools =
    copy(permissions = permissions ?: emptyMap(), toolsets = toolsets ?: emptyList())

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
            _ui.update { it.copy(loading = false, original = profile.data, draft = profile.data, catalog = catalog) }
        }
    }

    /** Flips every role-governable tool on this server between ALLOW and OFF in one write —
     *  see the file header for why this is a 2-state stand-in, not the real master control. */
    fun toggleServer(id: String) = editTools { draft, catalog ->
        val entry = catalog.servers[id] ?: return@editTools draft.tools
        val isOn = entry.tools.any { effectiveToolPermission(draft.tools.permissions, id, it) != ToolPermission.OFF }
        val value = if (isOn) ToolPermission.OFF else ToolPermission.ALLOW
        val serverMap = entry.tools.associate { it.name to value } + (catalog.wildcardPermissionKey to value)
        log.info("toggle-server", mapOf("id" to id, "on" to !isOn))
        draft.tools.copy(permissions = (draft.tools.permissions ?: emptyMap()) + (id to serverMap))
    }

    fun toggleTool(serverId: String, toolName: String) = editTools { draft, catalog ->
        val entry = catalog.servers[serverId] ?: return@editTools draft.tools
        val tool = entry.tools.find { it.name == toolName } ?: return@editTools draft.tools
        val current = effectiveToolPermission(draft.tools.permissions, serverId, tool)
        val next = if (current == ToolPermission.OFF) ToolPermission.ALLOW else ToolPermission.OFF
        val serverMap = (draft.tools.permissions?.get(serverId) ?: emptyMap()) + (toolName to next)
        draft.tools.copy(permissions = (draft.tools.permissions ?: emptyMap()) + (serverId to serverMap))
    }

    fun toggleToolset(toolset: String) = editTools { draft, _ ->
        val current = draft.tools.toolsets ?: emptyList()
        val next = if (toolset in current) current - toolset else current + toolset
        draft.tools.copy(toolsets = next)
    }

    private inline fun editTools(
        transform: (ProfileV1, McpCatalogView) -> ProfileTools,
    ) {
        _ui.update { s ->
            val draft = s.draft ?: return@update s
            val catalog = s.catalog ?: return@update s
            s.copy(draft = draft.copy(tools = transform(draft, catalog)), alreadyApplying = false, applyError = null)
        }
    }

    fun save() {
        val state = _ui.value
        val previous = state.original ?: return
        val next = state.draft ?: return
        if (!state.dirty || state.applyActive) return
        log.info(
            "save",
            mapOf("servers" to (next.tools.permissions?.size ?: 0), "toolsets" to (next.tools.toolsets?.size ?: 0)),
        )
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutProfile(previous, next)).collect { st ->
                _ui.update { it.foldApply(st) }
                if (st is ApplyState.Ready) refetch()
            }
        }
    }

    private suspend fun refetch() {
        when (val r = component.profileRepository.getProfile()) {
            is SentientResult.Success -> _ui.update { it.copy(original = r.data, draft = r.data) }
            is SentientResult.Failure -> log.warn("refetch.failed", mapOf("kind" to r.error.kind))
            is SentientResult.Loading -> Unit
        }
    }
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
