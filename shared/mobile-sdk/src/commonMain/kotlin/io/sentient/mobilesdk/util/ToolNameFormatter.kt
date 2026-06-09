package io.sentient.mobilesdk.util

/**
 * Strips routing prefixes from a raw tool name for display in a task pill —
 * ports webui tool-pill-strip.tsx `shortToolName`.
 *
 * The wire `toolName` carries layered routing prefixes (gateway MCP route →
 * Hermes adapter route), e.g.:
 *   `mcp_duckduckgo_web_search`    → `web_search`
 *   `assistant_ha_search_entities` → `search_entities`
 *
 * Each prefix is `(mcp|assistant)_<route>_`; iterate so layered prefixes all peel
 * off. The original name is preserved by the caller (e.g. as a long-press / hover
 * detail) and returned unchanged if stripping would leave nothing.
 */
private val TOOL_PREFIX_RE = Regex("^(mcp|assistant)_[^_]+_")

fun formatToolName(rawName: String): String {
    var n = rawName
    while (true) {
        val next = n.replace(TOOL_PREFIX_RE, "")
        if (next == n) break
        n = next
    }
    return if (n.isNotEmpty()) n else rawName
}
