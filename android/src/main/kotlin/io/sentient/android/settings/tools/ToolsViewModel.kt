// ---------------------------------------------------------------------------
// ToolsViewModel — Tools settings page. SLOW save: a full-profile PUT whose `tools`
// changed → PUT then apply (Hermes restart). Loads the profile + the MCP catalog;
// holds `original` + `draft`.
//
// enabled-map semantics (mirrors webui tools-pane EXACTLY):
//   profile.tools.enabled: Map<serverId, List<toolName>>
//     - key ABSENT           → server OFF (disabled).
//     - key present, list []  → server ON, inheriting the operator default whitelist
//                               (entry.defaultInclude).
//     - key present, non-empty → server ON, exactly those tools enabled.
//   Toggle server ON  → materialize enabled[id] = defaultInclude (not []), so the
//                       per-tool checkboxes start canonical and a re-toggle can't
//                       resurrect tools the user already turned off.
//   Toggle server OFF → remove the key.
//   Toggle a tool     → materialize the baseline (default when empty) then add/remove.
//   profile.tools.toolsets: List<String>? — Hermes built-ins; a builtin row is ON
//   iff its toolset ∈ toolsets. Toggling flips the whole toolset.
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
    /** Compares with `toolsets` normalized (null → empty) — the server can round-trip a
     *  never-configured toolsets as either null or [], and those are semantically identical;
     *  comparing raw would spuriously flag a save as dirty on a profile the user never touched. */
    val dirty: Boolean
        get() = original != null && draft != null && draft.tools.normalized() != original.tools.normalized()

    val applyActive: Boolean get() = saving || restarting
}

private fun ProfileTools.normalized(): ProfileTools = copy(toolsets = toolsets ?: emptyList())

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

    fun toggleServer(id: String) = editTools { draft, catalog ->
        val entry = catalog.servers[id] ?: return@editTools draft.tools
        val enabled = draft.tools.enabled
        val next = if (id in enabled) enabled - id else enabled + (id to entry.defaultInclude)
        log.info("toggle-server", mapOf("id" to id, "on" to (id !in enabled)))
        draft.tools.copy(enabled = next)
    }

    fun toggleTool(serverId: String, toolName: String) = editTools { draft, catalog ->
        val entry = catalog.servers[serverId] ?: return@editTools draft.tools
        val current = draft.tools.enabled[serverId] ?: return@editTools draft.tools
        val baseline = if (current.isEmpty()) entry.defaultInclude else current
        val nextList = if (toolName in baseline) baseline - toolName else baseline + toolName
        draft.tools.copy(enabled = draft.tools.enabled + (serverId to nextList))
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
        log.info("save", mapOf("servers" to next.tools.enabled.size, "toolsets" to (next.tools.toolsets?.size ?: 0)))
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
