// ---------------------------------------------------------------------------
// ToolsViewModelLogicTest — pins the SECURITY-CRITICAL invariant ToolsViewModel.kt's
// header documents: turning a tool/server "on" must be a CLEAR (null), never a
// concrete ALLOW, which would silently escalate a confirm-tier tool's role-template
// ASK to auto-approved. A regression here previously shipped with zero test coverage
// (the ViewModel hand-rolled ToolPermission.ALLOW inline instead of calling the shared
// withServerMasterPermission/withToolPermission helpers) — this test exercises the
// exact wiring (isServerOn / serverToggleWrite / toolToggleWrite) that decides which
// direction a toggle writes, independent of the ViewModel/SettingsComponent (which
// isn't unit-testable without a real HttpClient — see android-testing.md Layer 1).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import io.sentient.mobilesdk.settings.ImpactTier
import io.sentient.mobilesdk.settings.McpCatalogEntry
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.McpToolView
import io.sentient.mobilesdk.settings.ToolPermission
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

private fun tool(name: String, permission: ToolPermission): McpToolView =
    McpToolView(name = name, description = "", tier = ImpactTier.READ, permission = permission, settable = true)

private fun catalog(vararg tools: McpToolView, wildcardKey: String = "*"): McpCatalogView = McpCatalogView(
    servers = mapOf("household" to McpCatalogEntry(tools = tools.toList())),
    wildcardPermissionKey = wildcardKey,
)

class ToolsViewModelLogicTest {

    // ── isServerOn ──

    @Test
    fun `isServerOn is false when every catalog tool resolves off`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.OFF))
        assertFalse(isServerOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isServerOn is true when any catalog tool resolves on`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.ASK))
        assertEquals(true, isServerOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isServerOn reads pending edits over the catalog snapshot`() {
        val cat = catalog(tool("look_up", ToolPermission.ALLOW))
        val pending = mapOf("household" to mapOf("look_up" to ToolPermission.OFF))
        assertFalse(isServerOn(pending, cat, "household"))
    }

    // ── serverToggleWrite: the security-critical direction ──

    @Test
    fun `server toggle off-to-on clears every tool and the wildcard never a concrete allow`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.OFF))
        val write = serverToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertNull(server?.get("look_up"))
        assertNull(server?.get("unlock_door"))
        assertNull(server?.get("*"))
        assertFalse(server.orEmpty().values.contains(ToolPermission.ALLOW), "must never write a blanket ALLOW: $server")
    }

    @Test
    fun `server toggle on-to-off writes an explicit OFF everywhere`() {
        val cat = catalog(tool("look_up", ToolPermission.ASK), tool("unlock_door", ToolPermission.OFF))
        val write = serverToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertEquals(ToolPermission.OFF, server?.get("look_up"))
        assertEquals(ToolPermission.OFF, server?.get("unlock_door"))
        assertEquals(ToolPermission.OFF, server?.get("*"))
    }

    @Test
    fun `server toggle uses the catalog's own wildcard key never a hardcoded literal`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), wildcardKey = "ALL")
        val write = serverToggleWrite(emptyMap(), cat, "household")
        assertEquals(setOf("look_up", "ALL"), write["household"]?.keys)
    }

    // ── toolToggleWrite: the security-critical direction ──

    @Test
    fun `tool toggle off-to-on clears the tool never a concrete allow`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF))
        val write = toolToggleWrite(emptyMap(), cat, "household", "look_up")
        assertNull(write["household"]?.get("look_up"))
        assertFalse(write["household"].orEmpty().values.contains(ToolPermission.ALLOW))
    }

    @Test
    fun `tool toggle on-to-off writes an explicit OFF`() {
        val cat = catalog(tool("look_up", ToolPermission.DENY))
        val write = toolToggleWrite(emptyMap(), cat, "household", "look_up")
        assertEquals(ToolPermission.OFF, write["household"]?.get("look_up"))
    }

    @Test
    fun `tool toggle preserves a sibling tool's own pending edit`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.ASK))
        val pending = mapOf("household" to mapOf("unlock_door" to ToolPermission.OFF))
        val write = toolToggleWrite(pending, cat, "household", "look_up")
        assertEquals(ToolPermission.OFF, write["household"]?.get("unlock_door"), "sibling edit must survive")
        assertNull(write["household"]?.get("look_up"))
    }
}
