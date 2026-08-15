package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Stable product-facing exposure; it is independent of MCP/native transport. */
@Serializable
enum class ToolDefaultExposure {
    @SerialName("standard") STANDARD,
    @SerialName("advanced") ADVANCED,
}

@Serializable
enum class ToolDispatchKind {
    @SerialName("mcp") MCP,
    @SerialName("native") NATIVE,
}

@Serializable
data class ToolDispatchView(
    val kind: ToolDispatchKind,
    val serverName: String? = null,
)

@Serializable
data class McpToolView(
    val name: String,
    val description: String,
    val tier: ImpactTier,
    val permission: ToolPermission,
    val settable: Boolean,
    val dispatch: ToolDispatchView = ToolDispatchView(kind = ToolDispatchKind.NATIVE),
)

@Serializable
data class ProductToolGroupView(
    val tools: List<McpToolView> = emptyList(),
    val wildcardPermission: ToolPermission? = null,
    val defaultExposure: ToolDefaultExposure = ToolDefaultExposure.STANDARD,
    val description: String? = null,
)

@Serializable
data class HermesBuiltinToolView(val name: String, val description: String, val toolset: String)

/** Exact GET /api/v1/mcp-catalog wire shape. Permissions are keyed by these
 * stable group ids, never by the dispatch server carried in a tool row. */
@Serializable
data class McpCatalogView(
    val groups: Map<String, ProductToolGroupView> = emptyMap(),
    val wildcardPermissionKey: String = "*",
    val hermesBuiltins: List<HermesBuiltinToolView> = emptyList(),
)
