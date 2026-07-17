// ---------------------------------------------------------------------------
// McpCatalogModels — mirror of the GET /api/v1/mcp-catalog view
// (gateway/src/api/handlers/mcp-catalog.ts McpCatalogView), used by the Tools
// page to render per-server + per-tool toggles and the Hermes built-ins group.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.Serializable

/** One tool the UI can toggle (name + one-line description). */
@Serializable
data class McpToolView(val name: String, val description: String)

/**
 * Per-server catalog entry. `tools` is the operator-declared universe;
 * `defaultInclude` is the operator whitelist inherited when the user's
 * per-server list is empty.
 */
@Serializable
data class McpCatalogEntry(
    val tools: List<McpToolView> = emptyList(),
    val defaultInclude: List<String> = emptyList(),
    val description: String? = null,
)

/** A Hermes built-in tool — flipping it toggles its whole `toolset`. */
@Serializable
data class HermesBuiltinToolView(val name: String, val description: String, val toolset: String)

/** GET /api/v1/mcp-catalog → {servers, hermesBuiltins}. */
@Serializable
data class McpCatalogView(
    val servers: Map<String, McpCatalogEntry> = emptyMap(),
    val hermesBuiltins: List<HermesBuiltinToolView> = emptyList(),
)
