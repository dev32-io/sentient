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
 * caller of it) never deletes a map key itself.
 *
 * DROPPING A SERVER KEY FROM THE PATCH IS SIMPLY A NO-OP for that server, and
 * NOT the "off forever" the absent-server rule describes. The two are different
 * maps. `profile-update.ts` does a per-server, per-tool DELTA merge: a key this
 * patch omits is left exactly as stored. The absent-server rule
 * (`resolve-tool-permission.ts#storedPermissionFor`) is a property of the
 * STORED table — a server that has no key there at all — and no PUT can put the
 * table into that state by omission. Keys are carried forward here to match the
 * full-resend convention every other PUT field follows (see
 * [mergeToolPermissionPatch], which states the same thing), not to avert a
 * wipe.
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

/** Product-group spellings for new mobile settings callers. */
fun withProductGroupToolPermission(
    permissions: ToolPermissionPatchMap?,
    groupId: String,
    toolName: String,
    permission: ToolPermission?,
): ToolPermissionPatchMap = withToolPermission(permissions, groupId, toolName, permission)

fun withProductGroupMasterPermission(
    permissions: ToolPermissionPatchMap?,
    groupId: String,
    toolNames: List<String>,
    wildcardKey: String,
    turnOn: Boolean,
): ToolPermissionPatchMap = withServerMasterPermission(permissions, groupId, toolNames, wildcardKey, turnOn)

/**
 * Merges a session's accumulated pending edits ([overlay] — built incrementally via
 * [withToolPermission] / [withServerMasterPermission], seeded from an empty map) on top of
 * the ORIGINALLY-LOADED stored permissions ([base]) at SAVE time, producing the patch to
 * actually PUT.
 *
 * NOT NEEDED TO KEEP AN UNTOUCHED SERVER FROM TURNING OFF — the gateway's PUT handler
 * (`gateway/src/profile-store/profile-update.ts`) does a genuine per-server, per-tool DELTA
 * merge: a server or tool key the incoming patch omits is left UNTOUCHED in storage, never
 * reinterpreted as "off" because this one request didn't mention it. Sending [overlay] alone
 * (only the keys this session actually touched) would be safe server-side. This function
 * exists instead to match the FULL-RESEND convention every other [ProfileV1PutBody] field
 * already follows (model/voice/audio/persona/compression/advanced are always sent as the
 * complete current value, never a partial diff) — without it, `tools.permissions` would be
 * the one field in the body that behaves like a true partial patch, inconsistent with the
 * rest; the webui's own tools-pane follows the identical full-resend convention by keeping
 * the FULL loaded permissions as its live draft state rather than a separate overlay.
 *
 * This merges at the TOOL-NAME level within each server too (not a per-server whole-map
 * replace): [base]'s other tools under a server the person partially edited are carried
 * forward exactly as [withToolPermission] already promises for a single edit — this is just
 * that same carry-forward guarantee applied once, across every server, at the point a whole
 * session's edits are flattened into one write.
 *
 * A concrete [base] leaf is always a valid patch leaf (see [ProfileV1.toPutBody]), so only
 * [overlay]'s own keys can carry a `null` clear — this function never invents one.
 */
fun mergeToolPermissionPatch(base: ToolPermissionMap?, overlay: ToolPermissionPatchMap): ToolPermissionPatchMap {
    val servers = base.orEmpty().keys + overlay.keys
    return servers.associateWith { server ->
        val baseServerMap: Map<String, ToolPermission?> = base?.get(server).orEmpty()
        baseServerMap + overlay[server].orEmpty()
    }
}
