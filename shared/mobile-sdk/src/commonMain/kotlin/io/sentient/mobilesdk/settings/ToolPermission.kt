// ---------------------------------------------------------------------------
// ToolPermission — what the gateway does when the model calls a tool. Mirrors
// gateway/shared/config's toolPermissionSchema (@sentient/config) EXACTLY.
//
// A REAL Kotlin enum, deliberately UNLIKE the other wire "enum-like" fields in
// this package (ProfileEnums: model.provider, voice.provider, audio.channel,
// advanced.reasoningEffort are plain Strings so an unknown future value decodes
// and round-trips untouched). Permission and tier are the one place this
// codebase wants the OPPOSITE resilience: `when` over [ToolPermission] and
// [ImpactTier] must be EXHAUSTIVE, no `else ->`, so a future fifth state
// (`auto`, once a classifier exists — plan 2026-08-07-tool-permissions) breaks
// every call site at COMPILE time instead of silently falling through. This is
// the stated reason the owner chose a settings dropdown over an N-way toggle.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 *   ALLOW — dispatched with no prompt.
 *   ASK   — the person is asked first (permission dialog).
 *   DENY  — auto-rejected with a reason the model SEES, so it can explain
 *           itself rather than silently improvising around a gap.
 *   OFF   — omitted from the model's tool list entirely; the model does not
 *           know the tool exists.
 *
 * DENY and OFF are deliberately distinct: DENY keeps the capability legible to
 * the model, OFF removes it. Never collapse them.
 */
@Serializable
enum class ToolPermission {
    @SerialName("allow") ALLOW,
    @SerialName("ask") ASK,
    @SerialName("deny") DENY,
    @SerialName("off") OFF,
}

/**
 * One person's whole permission table, STORED shape: MCP server name -> tool
 * name (or the catalog's `wildcardPermissionKey`) -> a CONCRETE permission.
 * Never null — see [ToolPermissionPatchMap] for the PUT-body shape whose
 * leaves may be. Mirrors gateway/shared/config's `ToolPermissionMap` exactly.
 *
 * An empty table is NOT "everything off" — see [ProfileTools.permissions]'s
 * doc comment for how presence/absence at each level is read.
 */
typealias ToolPermissionMap = Map<String, Map<String, ToolPermission>>

/**
 * One PUT body's whole per-tool intent: MCP server name -> tool name (or the
 * catalog's `wildcardPermissionKey`) -> a permission to WRITE, or `null` to
 * CLEAR that key back to "no stored opinion, let the role template answer
 * again" — the only way a client can express that without deleting anything.
 *
 * NEVER THE STORED SHAPE. A clear collapses to an absent key during the
 * gateway's merge and is never persisted as a literal `null` — see
 * [ProfileToolsPatch]'s doc comment for why this must stay a separate type
 * from [ToolPermissionMap] rather than one nullable-leaf type used for both.
 * Mirrors gateway/shared/config's `ToolPermissionPatchMap` exactly.
 */
typealias ToolPermissionPatchMap = Map<String, Map<String, ToolPermission?>>

/**
 * Reserved MCP-server key for the gateway's own FOREGROUND-NATIVE tools (skill
 * tools et al.) inside a person's permission table. Mirrors
 * gateway/shared/config's `NATIVE_TOOL_SERVER_KEY` ("native") EXACTLY — the
 * SAME namespace `McpCatalogView.nativeTools` entries resolve their stored
 * overrides under server-side (`resolve-tool-permission.ts`), so a control
 * that writes `permissions[NATIVE_TOOL_SERVER_KEY][toolName]` is read back on
 * the very next dispatch exactly like an MCP tool's own server key.
 *
 * `delegateTask` is the one exception: it also lives in `nativeTools`, but
 * `settable: false` — its resolved `serverName` is `null`, not this key, so no
 * client write is ever read back for it. Branch on `McpToolView.settable`,
 * never on the tool's name, to tell the two apart (see [McpToolView]'s own
 * doc comment).
 */
const val NATIVE_TOOL_SERVER_KEY: String = "native"
