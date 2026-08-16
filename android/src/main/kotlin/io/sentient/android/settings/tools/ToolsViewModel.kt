// ---------------------------------------------------------------------------
// ToolsViewModel — Tools settings page. SLOW save: a full-profile PUT whose `tools`
// changed → PUT then apply (Hermes restart). Loads the profile + the MCP catalog.
//
// Four-state per-tool permission model (2026-08-07-tool-permissions task 9,
// replacing task 7's interim two-state Switch): every MCP-server tool AND every
// gateway-native tool (product-group catalog, e.g. delegateTask) carries its
// own ALLOW/ASK/DENY/OFF permission, rendered by ToolsScreen as a RowSelect
// dropdown (see ToolPermissionOptions.kt). The server header row keeps a two-state
// master Switch — a bulk convenience over every tool on that server, unchanged
// from task 7 — while each tool's own row is independently settable to any of the
// four values and stays visible whenever its server section is expanded,
// regardless of what the master switch currently reads.
//
// SECURITY-CRITICAL: the master Switch's "on" direction writes a CLEAR (`null`),
// NEVER a concrete ALLOW — a blanket ALLOW would silently escalate a confirm-tier
// tool's role-template ASK to auto-approved (the exact shipped-and-caught-on-web
// bug, then shipped-and-caught again in this ViewModel's own task-7 interim,
// withProductGroupMasterPermission exists to prevent; see ToolPermissionPatch.kt). A
// single tool's own dropdown is different: it ALWAYS writes one of the four
// concrete values it displays — there is no "clear" option in a per-tool control,
// only the bulk master write ever clears. Pending edits live in
// `pendingPermissions` — a PATCH overlay (nullable leaves) — NEVER folded into a
// ProfileV1/ProfileTools, which is concrete-only BY DESIGN and structurally cannot
// hold a clear (see ProfileTools.permissions's doc comment). This mirrors iOS's
// draftPermissions pattern for the identical reason: the stored KMP type cannot
// express what a pending edit here needs to.
//
// The overlay is merged onto the loaded profile's OWN stored permissions only at
// save time (mergeToolPermissionPatch) so `tools.permissions` matches every other
// ProfileV1PutBody field's full-resend convention — NOT because an omitted
// server/tool key would be read as "off" by the gateway. `profile-update.ts` does
// a genuine per-server, per-tool DELTA merge: a key this session never touched is
// left untouched in storage regardless of whether the PUT body repeats it. See
// mergeToolPermissionPatch's own doc comment for the corrected reasoning.
//
// Reads go through effectiveToolPermission (shared pure helper,
// io.sentient.mobilesdk.settings.ToolPermissionPatch.kt) so this screen's notion of
// "what does this tool currently read" can never drift from what the ToolBroker
// actually resolves.
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
import io.sentient.mobilesdk.settings.ProductToolGroupView
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.ProfileToolsPatch
import io.sentient.mobilesdk.settings.ProfileV1
import io.sentient.mobilesdk.settings.ToolPermission
import io.sentient.mobilesdk.settings.ToolPermissionPatchMap
import io.sentient.mobilesdk.settings.effectiveToolPermission
import io.sentient.mobilesdk.settings.effectiveWildcardPermission
import io.sentient.mobilesdk.settings.mergeToolPermissionPatch
import io.sentient.mobilesdk.settings.toPutBody
import io.sentient.mobilesdk.settings.withProductGroupMasterPermission
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
        viewModelScope.launch { reload() }
    }

    /** Re-reads BOTH server-truth inputs — the profile AND the catalog — and drops this
     *  session's pending edits. Every row on this screen renders from
     *  `catalog.groups[*].tools[*].permission` and `catalog.groups[*].wildcardPermission`,
     *  which are the RESOLVED values the gateway computed at fetch time; reloading only the
     *  profile would leave the whole screen showing pre-save permissions after a successful
     *  save, and the master Switch reading a stale wildcard while the server is genuinely
     *  off on the gateway. iOS's `save()` already re-runs its whole `load()` for this
     *  reason. */
    private suspend fun reload() {
        _ui.update { it.copy(loading = true, loadError = null) }
        val profile = component.profileRepository.getProfile()
        if (profile !is SentientResult.Success) {
            val msg = (profile as? SentientResult.Failure)?.error?.userMessage ?: "Couldn't load profile."
            log.warn("load.profile.failed")
            _ui.update { it.copy(loading = false, loadError = msg) }
            return
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

    /** Flips every role-governable tool on this server between "on" (CLEARED to each
     *  tool's own role-template answer) and an explicit OFF. NEVER a blanket ALLOW —
     *  see the file header and [groupToggleWrite]. */
    fun toggleGroup(id: String) = editPermissions { pending, catalog ->
        val turnedOn = !isGroupOn(pending, catalog, id)
        log.info("toggle-group", mapOf("id" to id, "on" to turnedOn))
        groupToggleWrite(pending, catalog, id)
    }

    /** One tool's own permission dropdown: writes [permission] verbatim — always one
     *  of the four concrete values the dropdown displays, never a clear. See the
     *  file header: only the server master Switch ([toggleServer]) ever clears back
     *  to the role template; a single tool's control has no "clear" option. */
    fun setToolPermission(serverId: String, toolName: String, permission: ToolPermission) = editPermissions { pending, _ ->
        log.info(
            "set-tool-permission",
            mapOf("serverId" to serverId, "tool" to toolName, "permission" to permission.name),
        )
        withToolPermission(pending, serverId, toolName, permission)
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
        // mergeToolPermissionPatch flattens this session's pendingPermissions onto the
        // originally-loaded stored table so tools.permissions matches every other
        // ProfileV1PutBody field's full-resend convention — NOT because omitting an
        // untouched server/tool would turn it off. The gateway's PUT handler
        // (profile-update.ts) does a genuine per-server, per-tool DELTA merge; an
        // omitted key is left untouched in storage (see mergeToolPermissionPatch's own
        // doc comment for the corrected reasoning).
        val next = original.toPutBody().copy(
            tools = ProfileToolsPatch(
                permissions = mergeToolPermissionPatch(original.tools.permissions, state.pendingPermissions),
                toolsets = state.pendingToolsets ?: original.tools.toolsets,
            ),
        )
        viewModelScope.launch {
            component.applyProfileChange(ProfileMutation.PutProfile(original, next)).collect { st ->
                _ui.update { it.foldApply(st) }
                // The FULL reload, not a profile-only refetch: see [reload]. Matches iOS,
                // which awaits its own `load()` here for the same reason.
                if (st is ApplyState.Ready) reload()
            }
        }
    }
}

/**
 * Pure, directly-testable (no ViewModel / SettingsComponent needed): whether [id]'s server
 * master control currently reads "on", given [pending] edits layered over the catalog's
 * snapshot. This is BOTH what the Switch renders and what [groupToggleWrite] inverts, so
 * the two can never disagree about which direction a tap is going.
 *
 * Reads the WILDCARD via [effectiveWildcardPermission], exactly as web's tools-pane and
 * iOS's `isGroupOn` do — NOT "does any tool read as on" over
 * [effectiveToolPermission]. The difference is the whole bug: `effectiveToolPermission`
 * falls back with `?:`, which cannot tell a pending `null` CLEAR apart from "no edit here"
 * and so resurrects the catalog snapshot. On a server whose tools all resolve OFF at load,
 * the master's "on" write is exactly a set of `null` clears — so a `?:`-based read saw no
 * change, left the Switch unchecked, and recomputed `turnOn = true` on every subsequent
 * tap. The state could not be left. [effectiveWildcardPermission] exists precisely to make
 * that distinction, via `containsKey`.
 */
internal fun isGroupOn(pending: ToolPermissionPatchMap, catalog: McpCatalogView, id: String): Boolean {
    val entry = catalog.groups[id] ?: return false
    return effectiveWildcardPermission(
        pending,
        id,
        catalog.wildcardPermissionKey,
        entry.wildcardPermission,
    ) != ToolPermission.OFF
}

/**
 * How many of [id]'s tools currently read as anything other than OFF, for the header's
 * "n/total tools" label. Distinct from [isGroupOn] on purpose: the master control's state
 * is the wildcard, while the count is a per-tool tally, and web renders exactly this pair.
 *
 * A pending master "on" clear does NOT move this number until the save round-trips —
 * `effectiveToolPermission` deliberately does not re-simulate the resolver's cascade
 * client-side, so a cleared tool's role-template answer is not knowable here.
 */
internal fun activeToolCount(pending: ToolPermissionPatchMap, id: String, entry: ProductToolGroupView): Int =
    entry.tools.count { effectiveToolPermission(pending, id, it) != ToolPermission.OFF }

/**
 * Pure, directly-testable: the master-control write for [id] given its CURRENT effective
 * state — off → on clears every named tool + the wildcard (`withProductGroupMasterPermission`,
 * `turnOn = true`), on → off writes an explicit OFF everywhere. SECURITY-CRITICAL: the "on"
 * direction must NEVER be a concrete [ToolPermission.ALLOW] — see the file header.
 */
internal fun groupToggleWrite(
    pending: ToolPermissionPatchMap,
    catalog: McpCatalogView,
    id: String,
): ToolPermissionPatchMap {
    val entry = catalog.groups[id] ?: return pending
    val toolNames = entry.tools.map { it.name }
    return withProductGroupMasterPermission(pending, id, toolNames, catalog.wildcardPermissionKey, turnOn = !isGroupOn(pending, catalog, id))
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
