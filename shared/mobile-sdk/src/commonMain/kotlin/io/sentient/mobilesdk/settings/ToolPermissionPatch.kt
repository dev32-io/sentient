// ---------------------------------------------------------------------------
// ToolPermissionPatch — pure helpers shared by every tool-permission control on
// every platform (Android + iOS Tools screens). Ported 1:1 from gateway/webui's
// src/components/settings/panes/tool-permission-patch.ts — mirror THAT file's
// semantics and its own doc comments carry the fuller reasoning; this file only
// restates what a Kotlin caller needs to know to use it safely.
//
// WHY A SERVER MASTER CONTROL CANNOT JUST WRITE THE WILDCARD. Every account is
// seeded with a NAMED permission entry for every catalog tool its role can
// execute (gateway profile-defaults.ts#applyProfileDefaults). The resolver
// reads a tool's own named key BEFORE the server's wildcard — so on an
// already-seeded account, every tool already has an answer that outranks the
// wildcard, and writing only the wildcard changes nothing for any of them.
// [withServerMasterPermission] is what makes a bulk write actually reach an
// already-named tool too.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

/**
 * Returns a NEW permissions map with exactly ([serverId], [toolName]) set to
 * [permission]. Every other server, and every other tool-name key already
 * under [serverId] (including a previously-set wildcard entry), is carried
 * forward untouched.
 *
 * [permission] MAY be `null` — a CLEAR, not a delete. The gateway's merge is
 * what turns a `null` leaf into an absent stored key; this function (and every
 * caller of it) never deletes a map key itself. Dropping a SERVER key here
 * instead of carrying it forward would be a silent PERMANENT no-op on the next
 * save — the absent-server rule reads a missing key as "off forever" and never
 * consults the role template again for it.
 */
fun withToolPermission(
    permissions: ToolPermissionPatchMap?,
    serverId: String,
    toolName: String,
    permission: ToolPermission?,
): ToolPermissionPatchMap {
    val serverMap = permissions?.get(serverId).orEmpty()
    return permissions.orEmpty() + (serverId to (serverMap + (toolName to permission)))
}

/**
 * The server master control's actual write: a NAMED value for every
 * role-governable catalog tool on this server ([toolNames]), PLUS the
 * wildcard for whatever that list cannot enumerate (see this file's header
 * for why the wildcard alone is a no-op on a normal, already-seeded account).
 *
 * [turnOn] = `false` ("off"): writes an explicit [ToolPermission.OFF]
 * everywhere — a real, stored opinion that hides every one of this server's
 * tools from the model.
 *
 * [turnOn] = `true` ("on"): writes an explicit `null` everywhere instead of a
 * concrete value — each named tool falls back to ITS OWN role-template answer
 * rather than one blanket value, which is what keeps a `confirm`-tier tool's
 * ASK from becoming an auto-approved ALLOW (a shipped-and-caught-in-review
 * privilege-escalation bug on web; do not re-introduce it here). "On" ALSO
 * erases any per-tool override the person set deliberately on this server —
 * the stored table records no provenance, so there is no way to clear
 * "everything the template already agreed with" while preserving "everything
 * the person chose on purpose" without inventing data the table does not
 * carry.
 */
fun withServerMasterPermission(
    permissions: ToolPermissionPatchMap?,
    serverId: String,
    toolNames: List<String>,
    wildcardKey: String,
    turnOn: Boolean,
): ToolPermissionPatchMap {
    val value: ToolPermission? = if (turnOn) null else ToolPermission.OFF
    val namedWrites = toolNames.associateWith { value }
    val serverMap = permissions?.get(serverId).orEmpty()
    return permissions.orEmpty() + (serverId to (serverMap + namedWrites + (wildcardKey to value)))
}

/**
 * What a tool's permission control should show: this person's own pending or
 * previously-saved edit for that EXACT tool name if there is one, else the
 * catalog's already-resolved [McpToolView.permission]. Deliberately does NOT
 * re-simulate the resolver's cascade (wildcard, role template, fail-closed
 * backstop) client-side, so the settings screen can never drift from what the
 * ToolBroker actually enforces.
 *
 * A per-tool control never WRITES `null` (it only ever offers the four real
 * permissions), but a stray pending `null` reads as "no opinion" here too —
 * the honest fallback if one were ever present — which is also why this
 * always returns a concrete [ToolPermission], never `null`.
 */
fun effectiveToolPermission(
    permissions: ToolPermissionPatchMap?,
    serverId: String,
    tool: McpToolView,
): ToolPermission = permissions?.get(serverId)?.get(tool.name) ?: tool.permission

/**
 * What a server's master control should show: this person's own pending or
 * previously-saved wildcard write if there is one, else the catalog's
 * snapshot of it at load time ([McpCatalogEntry.wildcardPermission]).
 *
 * DELIBERATELY NOT a plain `?:` fallback. A pending CLEAR is stored as a real,
 * own `null` entry — falling back to the catalog snapshot whenever the read
 * value is `null` would treat that clear as "nothing here" and silently
 * resurrect a stale (possibly OFF) snapshot, exactly backwards from what the
 * person just asked for. [Map.containsKey] is what tells "an explicit pending
 * edit exists, and it happens to be null" apart from "no edit was made here".
 */
fun effectiveWildcardPermission(
    permissions: ToolPermissionPatchMap?,
    serverId: String,
    wildcardKey: String,
    catalogWildcard: ToolPermission?,
): ToolPermission? {
    val serverMap = permissions?.get(serverId) ?: return catalogWildcard
    if (!serverMap.containsKey(wildcardKey)) return catalogWildcard
    return serverMap[wildcardKey]
}
