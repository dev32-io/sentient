// ---------------------------------------------------------------------------
// McpCatalogModels — mirror of the GET /api/v1/mcp-catalog view
// (gateway/src/api/handlers/mcp-catalog.ts McpCatalogView), used by the Tools
// page to render per-server + per-tool permission controls and the Hermes
// built-ins group.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.Serializable

/**
 * One tool the UI can render a permission control for. Identical shape under
 * both [McpCatalogEntry.tools] and [McpCatalogView.nativeTools] — [settable]
 * is what a client branches on, never which array (or which tool NAME) a tool
 * came from.
 */
@Serializable
data class McpToolView(
    val name: String,
    val description: String,
    /** Who may ever reach this tool (`canExecute(role, tier)`), independent of
     *  [permission] (what happens when they do). */
    val tier: ImpactTier,
    /** This person's RESOLVED permission — already incorporates their stored
     *  overrides, this server's wildcard, and their role template, via the
     *  SAME resolver the ToolBroker's PDP dispatches through. No `inherited`
     *  flag, no tri-state: every tool carries exactly one concrete
     *  [ToolPermission]. */
    val permission: ToolPermission,
    /** Whether a PUT to `/api/v1/profile/me` can actually change [permission].
     *  `false` for exactly one tool today (`delegateTask`, under
     *  [McpCatalogView.nativeTools]): it is gateway-native, so no MCP server
     *  addresses it and no stored key any client writes is ever read back for
     *  it. A client MUST render an unsettable tool read-only — a control that
     *  saves successfully and changes nothing is worse than no control. */
    val settable: Boolean,
)

/**
 * Per-server catalog entry, already narrowed to what THIS PERSON'S ROLE may
 * ever execute (the role gate ran server-side — see [McpCatalogView.servers]).
 */
@Serializable
data class McpCatalogEntry(
    val tools: List<McpToolView> = emptyList(),
    /** Operator-curated default whitelist; predates per-tool permissions,
     *  superseded for governance purposes by each tool's own [McpToolView.permission]. */
    val defaultInclude: List<String> = emptyList(),
    /** This server's own wildcard entry (keyed by [McpCatalogView.wildcardPermissionKey]
     *  in the stored table), or `null` when the person has not set one. `null`
     *  does NOT mean every tool resolves to the role template — a person may
     *  still have per-tool overrides this field does not reflect; read each
     *  tool's own [McpToolView.permission] for that.
     *
     *  TO TURN THE WHOLE SERVER OFF, WRITING THIS KEY ALONE DOES NOTHING on any
     *  real account. Every account is seeded with a NAMED entry for every
     *  catalog tool its role can execute, and the resolver reads a tool's own
     *  name BEFORE this wildcard — so every tool already has an answer that
     *  outranks it. The correct write is a named `OFF` for every tool in
     *  [tools] PLUS the wildcard, which is exactly what
     *  `withServerMasterPermission` (ToolPermissionPatch.kt) does. Use it; do
     *  not re-derive it, and never delete the server's key
     *  (see [McpCatalogView.servers]). */
    val wildcardPermission: ToolPermission? = null,
    val description: String? = null,
)

/** A Hermes built-in tool — flipping it toggles its whole [toolset]. */
@Serializable
data class HermesBuiltinToolView(val name: String, val description: String, val toolset: String)

/** GET /api/v1/mcp-catalog → {servers, wildcardPermissionKey, nativeTools, hermesBuiltins}. */
@Serializable
data class McpCatalogView(
    /**
     * A server key is present here iff it has >= 1 tool this role can govern.
     * Do NOT infer "off" from a missing key in THIS READ view — a server can
     * be absent for reasons this shape does not distinguish (stdio transport,
     * zero role-governable tools, or simply not in the catalog).
     *
     * Contrast the STORED table: a server key absent from the ALREADY-
     * PERSISTED table (one that has never been given an entry) resolves as
     * "off" permanently at READ time (`resolve-tool-permission.ts`'s
     * `storedPermissionFor`) — but that is a property of the stored table,
     * not of any one PUT. The gateway's PUT handler
     * (`gateway/src/profile-store/profile-update.ts`) does a genuine
     * per-server, per-tool DELTA merge: a server key a PUT's permissions map
     * simply omits is left UNTOUCHED in storage, never wiped to "off" by the
     * omission itself. Clients still send the full table on every save,
     * matching every other `ProfileV1PutBody` field's full-resend convention
     * (not because the wire contract requires it) — using
     * [McpCatalogEntry.wildcardPermission] / [wildcardPermissionKey] for a
     * bulk write.
     */
    val servers: Map<String, McpCatalogEntry> = emptyMap(),
    /**
     * The literal sentinel key a client writes into a server's permission map
     * to set every tool on that server at once. Read this rather than
     * hardcoding `"*"` — if the sentinel ever changes, every client that reads
     * it here changes with it. Defaulted only so a degraded/never-loaded
     * catalog (e.g. a failed fetch) stays constructible; real code always
     * reads the wire value.
     */
    val wildcardPermissionKey: String = "*",
    /**
     * Gateway-native tools with no MCP server (today just `delegateTask`).
     * Governed by the same resolver and role gate as every catalog tool, just
     * addressed by declared tier instead of by server — cannot live under
     * [servers] because no `mcp_catalog` entry curates it. Empty for a role
     * that cannot reach the `confirm` tier (child, guest).
     */
    val nativeTools: List<McpToolView> = emptyList(),
    val hermesBuiltins: List<HermesBuiltinToolView> = emptyList(),
)
